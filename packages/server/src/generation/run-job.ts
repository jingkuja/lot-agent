import { randomUUID } from "node:crypto";
import { genCacheKey } from "../billing/gen-cache.js";
import { publicStaticUrl } from "../util/public-base.js";
import type { CreateResult, MediaType, PollResult, ReferenceInput, ReferenceMedia } from "@lot-agent/core";

/**
 * Media-neutral view of a generation provider. Both `ImageGenerationProvider`
 * and `VideoGenerationProvider` are structurally assignable to this — the job
 * runner stays generic over either while each provider's own surface carries no
 * `mediaType` parameter. The request accepts the union of media-specific fields
 * (image: size/n, video: durationSec/ratio); each adapter ignores what it doesn't use.
 */
export interface JobGenerationProvider {
  create(req: {
    prompt: string;
    model?: string;
    size?: string;
    n?: number;
    durationSec?: number;
    ratio?: string;
    quality?: string;
    input_reference?: ReferenceInput;
    reference_video?: ReferenceInput;
    reference_audio?: ReferenceInput;
    first_frame?: string;
    last_frame?: string;
    media?: ReferenceMedia[];
  }): Promise<CreateResult>;
  poll(taskId: string): Promise<PollResult>;
}

export interface RunJobDeps {
  provider: JobGenerationProvider;
  storage: { put(a: { key: string; body: Buffer; contentType: string }): Promise<{ url: string }> };
  db: {
    createAsset(a: Record<string, unknown>): Promise<void>;
    updateMessageGeneration(
      id: string,
      patch: { status: string; metadata: Record<string, unknown> },
      owner: { conversationId: string; userId: string }
    ): Promise<void>;
    /** The vendor's own task id, persisted so a restarted worker can resume polling. */
    getTaskVendorId(id: string): Promise<string | null | undefined>;
    setTaskVendorId(id: string, vendorTaskId: string): Promise<void>;
    /** Task-row status — the cross-process cancellation channel (server writes
     * 'cancelled', this worker observes it between polls). */
    getTaskStatus(id: string): Promise<string | null | undefined>;
  };
  meter: { record(r: Record<string, unknown>): Promise<unknown> };
  cache: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
  updateProgress(taskId: string, progress: number): Promise<void>;
  /** `maxBytes` is expected to be bound by the caller (per media type); this
   * only forwards the in-process abort signal through. */
  urlToBytes(url: string, opts?: { signal?: AbortSignal }): Promise<{ body: Buffer; mime: string }>;
  extFor(mime: string): string;
  modelId: string;
  vendorModel: string;
  /** In-process abort (BullMQ JobControl.signal); DB status covers cross-process. */
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown when a job observes its own cancellation; the task row is already
 * terminal, so the queue wrapper's guarded setTaskError becomes a no-op. */
export class JobCancelledError extends Error {
  constructor() {
    super("generation cancelled");
    this.name = "JobCancelledError";
  }
}

interface JobLike { id: string; userId: string; input: Record<string, unknown> }
type GenAssets = { url: string; mime: string; durationSec?: number }[];
/**
 * `downloadFailed` marks the case where the vendor DID produce the media (poll
 * returned `completed` with a url) but our local download of it failed. The
 * generation is not a real failure — `sourceUrl` is preserved so the user can
 * retry just the download (see `redownloadGenerationJob`) instead of paying to
 * regenerate the whole asset.
 */
type GenOut = { assetIds: string[]; assets: GenAssets; downloadFailed?: boolean; sourceUrl?: string; error?: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function publicReference(value: ReferenceInput | undefined): ReferenceInput | undefined {
  if (typeof value === "string") return publicStaticUrl(value);
  return value?.map(publicStaticUrl);
}

/**
 * Tokenhub's `/images/edits` accepts only `data:image/...;base64,...` inputs.
 * Reference uploads are stored as static URLs, so resolve them through the
 * worker's already guarded/bounded byte loader, then encode the exact bytes for
 * the edit request. Data URLs are deliberately normalized the same way.
 */
async function imageReferencesAsDataUrls(
  deps: RunJobDeps,
  media: ReferenceMedia[] | undefined
): Promise<ReferenceMedia[] | undefined> {
  if (!media?.length) return undefined;
  return Promise.all(media.map(async (item) => {
    const source = publicStaticUrl(item.url);
    const { body, mime } = await deps.urlToBytes(source, { signal: deps.signal });
    if (!mime.startsWith("image/")) {
      throw new Error(`image edit reference is not an image (${mime})`);
    }
    return { ...item, url: `data:${mime};base64,${body.toString("base64")}` };
  }));
}

/** Build the message-status writer bound to this job's owner + base metadata.
 * Shared by the create→poll→download path and the download-only retry path so
 * both render the same generation card (kind/mediaType/prompt/settings). */
function makeSetMsg(deps: RunJobDeps, job: JobLike, mediaType: MediaType, prompt: string) {
  const input = job.input;
  const assistantMessageId = input.assistantMessageId as string | undefined;
  const conversationId = input.conversationId as string | undefined;
  const baseMeta = {
    kind: "generation",
    mediaType,
    prompt,
    settings: { size: input.size, n: input.n, durationSec: input.durationSec, ratio: input.ratio },
  };
  return async (status: string, extra: Record<string, unknown>) => {
    if (assistantMessageId && conversationId) {
      await deps.db.updateMessageGeneration(
        assistantMessageId,
        { status, metadata: { ...baseMeta, status, ...extra } },
        { conversationId, userId: job.userId }
      );
    }
  };
}

/**
 * Download the vendor's finished media into our own storage, register the
 * asset, meter it, and flip the message to `completed`. If the download (or
 * store) fails after the vendor already produced the media, classify it as a
 * recoverable `download_failed` — persist `sourceUrl` on the message and return
 * a `downloadFailed` output rather than failing the whole generation. A
 * cancellation observed mid-download is re-raised so the caller marks the
 * message 'cancelled'.
 */
async function downloadAndFinalize(
  deps: RunJobDeps,
  job: JobLike,
  mediaType: MediaType,
  sourceUrl: string,
  cacheKey: string | null,
  setMsg: (status: string, extra: Record<string, unknown>) => Promise<void>
): Promise<GenOut> {
  try {
    const { body, mime } = await deps.urlToBytes(sourceUrl, { signal: deps.signal });
    const assetId = randomUUID();
    const key = `${assetId}.${deps.extFor(mime)}`;
    const { url } = await deps.storage.put({ key, body, contentType: mime });
    const durationSec = mediaType === "video" ? Number(job.input.durationSec ?? 5) : undefined;
    await deps.db.createAsset({ id: assetId, taskId: job.id, userId: job.userId, type: mediaType, storageKey: key, url, mime, sizeBytes: body.byteLength, durationSec });
    await deps.meter.record({ userId: job.userId, taskId: job.id, modelId: deps.modelId, usage: { inputCount: 0, outputCount: mediaType === "video" ? (durationSec ?? 1) : 1 } });
    const assets: GenAssets = [durationSec != null ? { url, mime, durationSec } : { url, mime }];
    const out: GenOut = { assetIds: [assetId], assets };
    if (cacheKey) await deps.cache.set(cacheKey, out);
    await setMsg("completed", { assets });
    await deps.updateProgress(job.id, 100);
    return out;
  } catch (err) {
    // A cancellation observed during the download is not a download failure —
    // let the caller finalize the message as 'cancelled'.
    if (err instanceof JobCancelledError) throw err;
    if (deps.signal?.aborted) throw new JobCancelledError();
    const message = err instanceof Error ? err.message : String(err);
    await setMsg("download_failed", { sourceUrl, error: message });
    return { assetIds: [], assets: [], downloadFailed: true, sourceUrl, error: message };
  }
}

export async function runGenerationJob(deps: RunJobDeps, job: JobLike, mediaType: MediaType): Promise<GenOut> {
  const input = job.input;
  const prompt = (input.prompt as string) ?? "";
  const media = input.media as ReferenceMedia[] | undefined;
  const inputReference = input.input_reference as ReferenceInput | undefined;
  const referenceVideo = input.reference_video as ReferenceInput | undefined;
  const referenceAudio = input.reference_audio as ReferenceInput | undefined;
  const firstFrame = input.first_frame as string | undefined;
  const lastFrame = input.last_frame as string | undefined;
  const sleep = deps.sleep ?? realSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 3000;
  const maxWaitMs = deps.maxWaitMs ?? 15 * 60 * 1000;

  const setMsg = makeSetMsg(deps, job, mediaType, prompt);

  // Cancellation is observed at every pause point of the job: the in-process
  // abort signal is instant, the task row covers a cancel issued from another
  // process (the HTTP server). Checked before spending money at the vendor
  // and between polls, so a cancelled job stops within one poll interval
  // instead of running out the 15-minute budget.
  const assertNotCancelled = async () => {
    if (deps.signal?.aborted) throw new JobCancelledError();
    if ((await deps.db.getTaskStatus(job.id)) === "cancelled") throw new JobCancelledError();
  };

  try {
    await assertNotCancelled();
    const cacheKey = genCacheKey(`${mediaType}.generate`, {
      userId: job.userId,
      prompt, size: input.size, n: input.n, durationSec: input.durationSec, ratio: input.ratio,
      input_reference: inputReference,
      reference_video: referenceVideo,
      reference_audio: referenceAudio,
      first_frame: firstFrame,
      last_frame: lastFrame,
      media: media?.map((m) => m.url), model: deps.vendorModel,
    });
    const cached = await deps.cache.get(cacheKey) as GenOut | null;
    if (cached) {
      await setMsg("completed", { assets: cached.assets });
      await deps.updateProgress(job.id, 100);
      return cached;
    }

    // Resume support: if this job already created a vendor task on a previous
    // run (worker crash / BullMQ stall-recovery re-delivers the same job),
    // reuse the persisted vendor task id and keep polling instead of paying to
    // create a duplicate generation.
    let vendorTaskId = await deps.db.getTaskVendorId(job.id);
    if (!vendorTaskId) {
      // Tokenhub image edits only accept Base64 data URLs. Video vendors fetch
      // references themselves, so those keep externally accessible URLs.
      const publicMedia = mediaType === "image"
        ? await imageReferencesAsDataUrls(deps, media)
        : media?.map((item) => ({ ...item, url: publicStaticUrl(item.url) }));
      const createRequest = {
        prompt,
        size: input.size as string | undefined,
        n: input.n as number | undefined,
        durationSec: input.durationSec as number | undefined,
        ratio: input.ratio as string | undefined,
        input_reference: publicReference(inputReference),
        reference_video: publicReference(referenceVideo),
        reference_audio: publicReference(referenceAudio),
        first_frame: firstFrame ? publicStaticUrl(firstFrame) : undefined,
        last_frame: lastFrame ? publicStaticUrl(lastFrame) : undefined,
        media: publicMedia,
      };
      // Keep the task id and resolved vendor model beside the request payload so
      // a video failure can be traced through the worker logs. Deliberately do
      // not log provider configuration or headers: those contain the API key.
      if (mediaType === "video") {
        console.log("[video.generate] request", JSON.stringify({
          taskId: job.id,
          model: deps.vendorModel,
          body: createRequest,
        }));
      }
      const created = await deps.provider.create(createRequest);
      vendorTaskId = created.taskId;
      await deps.db.setTaskVendorId(job.id, vendorTaskId);
    }

    const start = Date.now();
    let p = await deps.provider.poll(vendorTaskId);
    for (;;) {
      await deps.updateProgress(job.id, p.progress);
      if (p.status === "completed") break;
      if (p.status === "failed") throw new Error(p.error ?? "generation failed");
      if (Date.now() - start > maxWaitMs) throw new Error("generation timed out");
      await assertNotCancelled();
      await sleep(pollIntervalMs);
      p = await deps.provider.poll(vendorTaskId);
    }
    if (!p.url) throw new Error("generation completed without a url");

    return await downloadAndFinalize(deps, job, mediaType, p.url, cacheKey, setMsg);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      await setMsg("cancelled", {});
    } else {
      await setMsg("failed", { error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}

/**
 * Retry only the download step of a generation whose vendor media already
 * succeeded (message left in `download_failed`, `sourceUrl` re-supplied on the
 * job input). Skips the vendor create→poll entirely: no re-billing of the
 * generation, just a fresh attempt to pull the media into our storage. On
 * success the message flips to `completed`; a repeated download failure leaves
 * it `download_failed` again (retriable once more).
 */
export async function redownloadGenerationJob(deps: RunJobDeps, job: JobLike, mediaType: MediaType): Promise<GenOut> {
  const input = job.input;
  const prompt = (input.prompt as string) ?? "";
  const sourceUrl = input.sourceUrl as string | undefined;
  const setMsg = makeSetMsg(deps, job, mediaType, prompt);
  if (!sourceUrl) throw new Error("redownload requires a sourceUrl");
  if (deps.signal?.aborted) {
    await setMsg("cancelled", {});
    throw new JobCancelledError();
  }
  return await downloadAndFinalize(deps, job, mediaType, sourceUrl, null, setMsg);
}
