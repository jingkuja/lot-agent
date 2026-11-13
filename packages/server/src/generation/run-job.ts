import { ProviderError } from "@lot-agent/core";
import { GenerationError } from "./errors.js";
import { createHash } from "node:crypto";
import { ImageResultUnknown } from "./image-receipts.js";
import { genCacheKey } from "../billing/gen-cache.js";
import { billedVideoSeconds, resolveVideoGenerateAudio } from "./input.js";
import { publicStaticUrl } from "../util/public-base.js";
import { referenceDataUrl } from "./compose.js";
import { whitenBackground, type WhiteBackgroundCheck } from "./white-background.js";
import { renderPoster } from "./poster-render.js";
import { parsePosterLayout, type PosterLayout } from "@lot-agent/core/poster";
import { parsePosterReference, posterImageUrl, POSTER_UNAVAILABLE } from "./poster-library.js";
import type { PrepareKlingVoicesInput } from "./kling-voices.js";
import type { CreateResult, MediaType, PollResult, ReferenceInput, ReferenceMedia, GenerationCallOptions } from "@lot-agent/core";

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
    resolution?: string;
    n?: number;
    durationSec?: number;
    ratio?: string;
    quality?: string;
    generate_audio?: boolean;
    input_reference?: ReferenceInput;
    reference_video?: ReferenceInput;
    reference_audio?: ReferenceInput;
    first_frame?: string;
    last_frame?: string;
    media?: ReferenceMedia[];
  }, options?: GenerationCallOptions): Promise<CreateResult>;
  poll(taskId: string): Promise<PollResult>;
}

export interface RunJobDeps {
  provider: JobGenerationProvider;
  /** Authorize stable local material URLs, then mint an expiring vendor URL. */
  resolveReferenceUrl?: (url: string) => Promise<string>;
  /** Authorize an Agent-hosted image and return its externally accessible URL. */
  resolveImageReferenceUrl?: (url: string) => Promise<string>;
  prepareKlingVoices?: (input: PrepareKlingVoicesInput) => Promise<ReferenceInput>;
  /** Voice checkpoint owner when it is not this job: a marketing parent shares one voice per sample across its clips. */
  voiceScopeTaskId?: string;
  /** Read one of this job owner's stored outputs (`/static/assets/<key>`), for using an image of a set as a reference. */
  readOwnOutput?: (url: string) => Promise<{ body: Buffer; mime: string }>;
  storage: { put(a: { key: string; body: Buffer; contentType: string }): Promise<{ url: string }>;
    putStream(key: string, body: NodeJS.ReadableStream, contentType: string, sizeHint?: number): Promise<{ url: string }> };
  db: {
    getAsset(id: string): Promise<{ user_id: string } | null | undefined>;
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
    /** Change a generation message's metadata under a row lock; `update` returns null to leave it unchanged. */
    updateGenerationMetadata?(
      messageId: string,
      owner: { conversationId: string; userId: string },
      update: (metadata: Record<string, unknown>) => Record<string, unknown> | null
    ): Promise<boolean>;
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
  /** Receipt-backed tasks must resume before consulting cross-task output caches. */
  hasImageReceipts?: () => Promise<boolean>;
  hasImageReceipt?: (slot: number) => Promise<boolean>;
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
type GenOut = {
  assetIds: string[]; assets: GenAssets; downloadFailed?: boolean; sourceUrl?: string; sourceUrls?: string[]; error?: string;
  /** Image-set requests that produced no image (the rest of the set was kept). */
  missing?: number;
  /** 白底图: per image, whether the background was made pure white and what may still fail a listing check. */
  whiteChecks?: WhiteBackgroundCheck[];
  /** 真实字体: per image, the layout typeset on it and the stored text-free background it can be rendered on again. */
  posters?: PosterLayout[];
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function publicReference(deps: RunJobDeps, value: ReferenceInput | undefined): Promise<ReferenceInput | undefined> {
  const resolve = (url: string) => deps.resolveReferenceUrl?.(publicStaticUrl(url)) ?? Promise.resolve(publicStaticUrl(url));
  if (typeof value === "string") return resolve(value);
  return value ? Promise.all(value.map(resolve)) : undefined;
}

function usesImageReferenceUrls(model: string): boolean {
  return /^(linqu|lingqu)-image$/i.test(model);
}

function agentImageReferenceUrl(deps: RunJobDeps, url: string): Promise<string> {
  if (!deps.resolveImageReferenceUrl) throw new GenerationError("CONFIG_MISSING", "图片参考图链接服务未配置。");
  return deps.resolveImageReferenceUrl(url);
}

async function imageReferenceDataUrl(deps: RunJobDeps, source: string): Promise<string> {
  const { body, mime } = await deps.urlToBytes(source, { signal: deps.signal });
  if (!mime.startsWith("image/")) throw new Error(`image edit reference is not an image (${mime})`);
  return `data:${mime};base64,${body.toString("base64")}`;
}

/** Most image models need Base64 data URLs. URL-only models fetch Agent-hosted references. */
async function prepareImageReferences(
  deps: RunJobDeps,
  media: ReferenceMedia[] | undefined
): Promise<ReferenceMedia[] | undefined> {
  if (!media?.length) return undefined;
  if (usesImageReferenceUrls(deps.vendorModel)) {
    return Promise.all(media.map(async (item) => ({ ...item, url: await agentImageReferenceUrl(deps, item.url) })));
  }
  return Promise.all(media.map(async (item) => {
    const localOutput = item.url.startsWith("/static/assets/") || item.url.startsWith(publicStaticUrl("/static/assets/"));
    if (deps.readOwnOutput && localOutput) {
      const { body, mime } = await deps.readOwnOutput(item.url);
      return { ...item, url: `data:${mime};base64,${body.toString("base64")}` };
    }
    const source = await publicReference(deps, item.url) as string;
    return { ...item, url: await imageReferenceDataUrl(deps, source) };
  }));
}

async function preparePosterRemixReference(deps: RunJobDeps, value: unknown): Promise<ReferenceMedia> {
  const reference = parsePosterReference(value);
  const revision = (value as { revision?: unknown } | undefined)?.revision;
  if (!reference || typeof revision !== "string" || !/^[a-f0-9]{16}$/.test(revision)) {
    throw new GenerationError("GENERATION_FAILED", POSTER_UNAVAILABLE);
  }
  const url = posterImageUrl(reference, revision);
  if (usesImageReferenceUrls(deps.vendorModel)) return { type: "reference_image", url };
  try {
    return { type: "reference_image", url: await imageReferenceDataUrl(deps, url) };
  } catch {
    throw new GenerationError("GENERATION_FAILED", POSTER_UNAVAILABLE);
  }
}

/** Build the message-status writer bound to this job's owner + base metadata.
 * Shared by the create→poll→download path and the download-only retry path so
 * both render the same generation card (kind/mediaType/prompt/settings). */
function makeSetMsg(deps: RunJobDeps, job: JobLike, mediaType: MediaType, prompt: string, resolvedAudio?: ReferenceInput) {
  const input = job.input;
  const assistantMessageId = input.assistantMessageId as string | undefined;
  const conversationId = input.conversationId as string | undefined;
  const referenceAudio = resolvedAudio ?? input.reference_audio as ReferenceInput | undefined;
  // Keep the task id on every status write: the enqueue route stores it, and a
  // client that lost the submit response (mini program) recovers the task from
  // this message — including after the worker has already finished it.
  const baseMeta = {
    kind: "generation",
    mediaType,
    // Scene images send rewritten prompts to the model; the card keeps the user's own text.
    prompt: typeof input.displayPrompt === "string" ? input.displayPrompt : prompt,
    ...(typeof input.scene === "string" ? { scene: input.scene } : {}),
    // 真实字体: the planned wording stays on the message through every status, so a download retry can still typeset it.
    ...(parsePosterLayout(input.poster) ? { poster: input.poster } : {}),
    taskId: job.id,
    ...(typeof input.originalTaskId === "string" ? { originalTaskId: input.originalTaskId } : {}),
    ...(typeof input.missing === "number" && input.missing > 0 ? { missing: input.missing } : {}),
    ...(input.unknownResult === true ? { unknownResult: true } : {}),
    settings: {
      size: input.size,
      n: input.n,
      quality: input.quality,
      durationSec: input.durationSec,
      ratio: input.ratio,
      ...(typeof input.resolution === "string" ? { resolution: input.resolution } : {}),
      ...(mediaType === "video" ? { generate_audio: resolveVideoGenerateAudio(input.generate_audio, referenceAudio) } : {}),
    },
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

/** Pauses between download attempts. The media already exists at the vendor, so the GET is
 * free and safe to repeat; a dropped connection or a slow CDN often succeeds on the next try. */
const DOWNLOAD_RETRY_DELAYS_MS = [2000, 5000];

/** Fixed fields of a download failure for the log; the message and URL are left out
 * because a signed URL or a vendor body could appear in them. */
export function downloadFailureFields(error: unknown) {
  const e = (error ?? {}) as { name?: unknown; status?: unknown; code?: unknown; cause?: { code?: unknown } };
  const code = [e.code, e.cause?.code].find(value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(value));
  return { errorType: typeof e.name === "string" ? e.name : typeof error,
    ...(typeof e.status === "number" ? { httpStatus: e.status } : {}), ...(code ? { errorCode: code as string } : {}) };
}

async function fetchProduced(deps: RunJobDeps, taskId: string, sourceUrl: string) {
  const sleep = deps.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.urlToBytes(sourceUrl, { signal: deps.signal });
    } catch (err) {
      if (deps.signal?.aborted) throw new JobCancelledError();
      const last = attempt >= DOWNLOAD_RETRY_DELAYS_MS.length;
      console.warn("[generation.download] failed", { taskId, attempt: attempt + 1, final: last, ...downloadFailureFields(err) });
      if (last) throw err;
      await sleep(DOWNLOAD_RETRY_DELAYS_MS[attempt]);
      if (deps.signal?.aborted) throw new JobCancelledError();
    }
  }
}

/** The vendor urls to keep: one video, or up to the requested image count. */
function producedUrls(mediaType: MediaType, input: Record<string, unknown>, p: PollResult): string[] {
  const urls = (p.urls?.length ? p.urls : p.url ? [p.url] : []).filter((url): url is string => typeof url === "string" && !!url);
  const requested = mediaType === "image" && Number.isInteger(input.n) && Number(input.n) > 0 ? Number(input.n) : 1;
  return urls.slice(0, requested);
}

async function storeGeneratedAsset(
  deps: RunJobDeps, job: JobLike, type: MediaType, file: { body: Buffer; mime: string }, durationSec?: number,
  materialPurpose: "output" | "dependency" | "version" = job.input.redoMessageId ? "version" : "output",
) {
  const { body, mime } = file;
  const hash = createHash("sha256").update(job.userId).update(job.id).update(body).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const key = `${id}.${deps.extFor(mime)}`;
  const { url } = await deps.storage.put({ key, body, contentType: mime });
  await deps.db.createAsset({ id, taskId: job.id, userId: job.userId, type, storageKey: key, url, mime,
    sizeBytes: body.byteLength, durationSec, idempotent: true, materialPurpose: type === "image" ? materialPurpose : "output" });
  return { id, asset: durationSec != null ? { url, mime, durationSec } : { url, mime } };
}

/**
 * Download the vendor's finished media into our own storage, register the
 * assets, meter them, and flip the message to `completed`. A set's first image
 * may already be stored as a reference for later images. If a download (after
 * its retries, or the store) fails once the
 * vendor produced the media, classify it as a recoverable `download_failed` —
 * persist the source urls on the message and return a `downloadFailed` output
 * rather than failing the whole generation. A cancellation observed
 * mid-download is re-raised so the caller marks the message 'cancelled'.
 */
async function downloadAndFinalize(
  deps: RunJobDeps,
  job: JobLike,
  mediaType: MediaType,
  sourceUrls: string[],
  cacheKey: string | null,
  setMsg: (status: string, extra: Record<string, unknown>) => Promise<void>,
  firstAsset?: Awaited<ReturnType<typeof storeGeneratedAsset>>,
): Promise<GenOut> {
  const sourceUrl = sourceUrls[0];
  try {
    const files = [];
    for (const source of sourceUrls.slice(firstAsset ? 1 : 0)) files.push(await fetchProduced(deps, job.id, source));
    const durationSec = mediaType === "video" ? billedVideoSeconds(job.input.durationSec) : undefined;
    const assetIds = firstAsset ? [firstAsset.id] : [];
    const assets: GenAssets = firstAsset ? [firstAsset.asset] : [];
    const whiteBackground = mediaType === "image" && job.input.scene === "white_background";
    const whiteChecks: WhiteBackgroundCheck[] = [];
    const poster = mediaType === "image" ? parsePosterLayout(job.input.poster) : null;
    const posters: PosterLayout[] = [];
    for (const file of files) {
      let { body, mime } = file;
      if (poster) {
        // The model's picture has no text. Keep it as its own asset (a text edit renders on it again), then typeset.
        const background = await storeGeneratedAsset(deps, job, mediaType, { body, mime }, undefined, "dependency");
        const layout: PosterLayout = { ...poster, background: { url: background.asset.url } };
        try {
          const rendered = await renderPoster(body, layout);
          ({ body, mime } = rendered);
          posters.push({ ...layout, template: rendered.template, ...(rendered.overflow ? { overflow: true } : {}) });
        } catch (err) {
          // Best effort: the picture is kept without text and the card can typeset it again.
          console.warn("[image.poster] render failed", { taskId: job.id, errorType: (err as Error)?.name });
          posters.push(layout);
          assetIds.push(background.id);
          assets.push(background.asset);
          continue;
        }
      }
      if (whiteBackground) {
        // Best effort: an image that cannot be checked is stored as the model made it.
        try {
          const fixed = await whitenBackground(body, false);
          whiteChecks.push(fixed.check);
        } catch (err) {
          console.warn("[image.white_background] check failed", { taskId: job.id, errorType: (err as Error)?.name });
          whiteChecks.push({ corrected: false, issues: [], unknown: true });
        }
      }
      const { id, asset } = await storeGeneratedAsset(deps, job, mediaType, { body, mime }, durationSec);
      assetIds.push(id);
      assets.push(asset);
    }
    const outputCount = mediaType === "video" ? (durationSec ?? 1) : assets.length;
    await deps.meter.record({ userId: job.userId, taskId: job.id, modelId: deps.modelId, usage: { inputCount: 0, outputCount },
      idempotencyKey: `generation:${job.userId}:${job.input.originalTaskId ?? job.id}` });
    const checks = { ...(whiteChecks.length ? { whiteChecks } : {}), ...(posters.length ? { posters } : {}) };
    const out: GenOut = { assetIds, assets, ...checks };
    if (cacheKey) await deps.cache.set(cacheKey, out);
    await setMsg("completed", { assets, ...checks });
    await deps.updateProgress(job.id, 100);
    return out;
  } catch (err) {
    // A cancellation observed during the download is not a download failure —
    // let the caller finalize the message as 'cancelled'.
    if (err instanceof JobCancelledError) throw err;
    if (deps.signal?.aborted) throw new JobCancelledError();
    const message = new ProviderError("generation", "download", "TRANSPORT_ERROR").message;
    const multiple = sourceUrls.length > 1 ? { sourceUrls } : {};
    await setMsg("download_failed", { sourceUrl, ...multiple, error: message });
    return { assetIds: [], assets: [], downloadFailed: true, sourceUrl, ...multiple, error: message };
  }
}

/** Image-set prompts (主副图 / 产品套图): each makes one image with its own request. */
function imageSetPrompts(mediaType: MediaType, input: Record<string, unknown>): string[] | undefined {
  const prompts = input.prompts;
  if (mediaType !== "image" || !Array.isArray(prompts) || prompts.length < 2) return undefined;
  return prompts.every((prompt) => typeof prompt === "string" && prompt) ? prompts as string[] : undefined;
}

/** Vendor ids already submitted for an image set, so a re-delivered job never pays for an image twice. */
function parseSetVendorIds(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    const ids = JSON.parse(value) as unknown;
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) return ids as string[];
  } catch {
    // A plain id from a single-prompt run of the same task.
  }
  return [value];
}

export async function runGenerationJob(deps: RunJobDeps, job: JobLike, mediaType: MediaType): Promise<GenOut> {
  const input = job.input;
  const prompt = (input.prompt as string) ?? "";
  const setPrompts = imageSetPrompts(mediaType, input);
  const media = input.media as ReferenceMedia[] | undefined;
  const posterRemix = mediaType === "image" && input.scene === "poster_remix";
  const inputReference = input.input_reference as ReferenceInput | undefined;
  const referenceVideo = input.reference_video as ReferenceInput | undefined;
  const klingVideo = mediaType === "video" && /kling/i.test(deps.vendorModel);
  const legacyAudio = klingVideo ? media?.filter((item) => item.type === "reference_audio").map((item) => item.url) : undefined;
  const referenceAudio = (input.reference_audio as ReferenceInput | undefined)
    ?? (legacyAudio?.length ? legacyAudio : undefined);
  const needsKlingVoices = klingVideo && (typeof referenceAudio === "string" ? !!referenceAudio : !!referenceAudio?.length);
  const generateAudio = mediaType === "video"
    ? resolveVideoGenerateAudio(input.generate_audio, referenceAudio)
    : undefined;
  const firstFrame = input.first_frame as string | undefined;
  const lastFrame = input.last_frame as string | undefined;
  const sleep = deps.sleep ?? realSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 3000;
  const maxWaitMs = deps.maxWaitMs ?? 15 * 60 * 1000;

  const setMsg = makeSetMsg(deps, job, mediaType, prompt, referenceAudio);

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
    // A new image task is a new creation. Recovery uses its own durable receipts, never another task's result.
    const cacheKey = mediaType === "image" ? null : genCacheKey(`${mediaType}.generate`, {
      userId: job.userId,
      prompt, ...(setPrompts ? { prompts: setPrompts } : {}),
      size: input.size, n: input.n, quality: input.quality, durationSec: input.durationSec, ratio: input.ratio,
      ...(mediaType === "video" && typeof input.resolution === "string" ? { resolution: input.resolution } : {}),
      input_reference: inputReference,
      reference_video: referenceVideo,
      reference_audio: referenceAudio,
      ...(needsKlingVoices ? { klingVoiceVersion: 1 } : {}),
      generate_audio: generateAudio,
      first_frame: firstFrame,
      last_frame: lastFrame,
      media: media?.map((m) => m.url), model: deps.vendorModel,
    });
    const resuming = mediaType === "image" && await deps.hasImageReceipts?.();
    const cached = cacheKey && !resuming ? await deps.cache.get(cacheKey) as GenOut | null : null;
    const cachedAssets = cached ? await Promise.all(cached.assetIds.map((id) => deps.db.getAsset(id))) : [];
    if (cached && cachedAssets.length > 0 && cachedAssets.every((asset) => asset?.user_id === job.userId)) {
      await setMsg("completed", {
        assets: cached.assets, ...(cached.whiteChecks ? { whiteChecks: cached.whiteChecks } : {}), ...(cached.posters ? { posters: cached.posters } : {}),
      });
      await deps.updateProgress(job.id, 100);
      return cached;
    }

    if (setPrompts) {
      return await runImageSet(deps, job, setPrompts, cacheKey, setMsg, assertNotCancelled, {
        size: input.size as string | undefined,
        quality: (input.quality as string | undefined) ?? "auto",
        media: await prepareImageReferences(deps, media),
      });
    }

    // Resume support: if this job already created a vendor task on a previous
    // run (worker crash / BullMQ stall-recovery re-delivers the same job),
    // reuse the persisted vendor task id and keep polling instead of paying to
    // create a duplicate generation.
    let vendorTaskId = await deps.db.getTaskVendorId(job.id);
    let immediate: PollResult | undefined;
    if (!vendorTaskId) {
      let publicMedia = mediaType === "image"
        ? await prepareImageReferences(deps, media)
        : media ? await Promise.all(media.filter(item => !needsKlingVoices || item.type !== "reference_audio").map(async (item) => ({ ...item, url: await publicReference(deps, item.url) as string }))) : undefined;
      if (posterRemix) {
        const poster = await preparePosterRemixReference(deps, input.posterReference);
        publicMedia = [poster, ...(publicMedia ?? [])];
      }
      let publicInputReference = await publicReference(deps, inputReference);
      let publicVideoReference = await publicReference(deps, referenceVideo);
      let publicFirstFrame = firstFrame ? await publicReference(deps, firstFrame) as string : undefined;
      let publicLastFrame = lastFrame ? await publicReference(deps, lastFrame) as string : undefined;
      // Voice checkpoints fingerprint the original URL. Temporary capabilities
      // must never enter persisted input, cache keys or voice identity.
      let preparedAudio = needsKlingVoices
        ? typeof referenceAudio === "string" ? publicStaticUrl(referenceAudio) : referenceAudio?.map(publicStaticUrl)
        : await publicReference(deps, referenceAudio);
      if (needsKlingVoices && preparedAudio) {
        if (!deps.prepareKlingVoices) throw new GenerationError("CONFIG_MISSING", "Kling 音色服务未配置，无法提交参考声音。");
        preparedAudio = await deps.prepareKlingVoices({
          taskId: deps.voiceScopeTaskId ?? job.id, userId: job.userId, referenceAudio: preparedAudio,
          signal: deps.signal, assertNotCancelled,
          resolveReferenceUrl: deps.resolveReferenceUrl,
        });
        // Voice preparation can take minutes. Refresh image/video capabilities
        // immediately before submission; the preflight above still prevents
        // invalid references from starting a paid voice request.
        publicInputReference = await publicReference(deps, inputReference);
        publicVideoReference = await publicReference(deps, referenceVideo);
        publicFirstFrame = firstFrame ? await publicReference(deps, firstFrame) as string : undefined;
        publicLastFrame = lastFrame ? await publicReference(deps, lastFrame) as string : undefined;
        publicMedia = media ? await Promise.all(media.filter(item => item.type !== "reference_audio").map(async item => ({ ...item, url: await publicReference(deps, item.url) as string }))) : undefined;
      }
      await assertNotCancelled();
      const createRequest = {
        prompt,
        size: input.size as string | undefined,
        ...(mediaType === "video" && typeof input.resolution === "string" ? { resolution: input.resolution } : {}),
        n: input.n as number | undefined,
        quality: (input.quality as string | undefined) ?? (mediaType === "image" ? "auto" : undefined),
        durationSec: input.durationSec as number | undefined,
        ratio: input.ratio as string | undefined,
        input_reference: publicInputReference,
        reference_video: publicVideoReference,
        reference_audio: preparedAudio,
        generate_audio: generateAudio,
        first_frame: publicFirstFrame,
        last_frame: publicLastFrame,
        // Dedicated voice IDs replace all legacy audio URLs for Kling.
        media: needsKlingVoices ? publicMedia?.filter((item) => item.type !== "reference_audio") : publicMedia,
      };
      // Log identifiers only. Prompts and material capabilities are private.
      if (mediaType === "video" || mediaType === "image") {
        console.log(`[${mediaType}.generate] request`, JSON.stringify({
          taskId: job.id,
          model: deps.vendorModel,
          durationSec: createRequest.durationSec,
        }));
      }
      const imageOptions = mediaType === "image" && (deps.signal || deps.hasImageReceipt || deps.hasImageReceipts)
        ? { signal: deps.signal, slot: 0 } : undefined;
      const created = mediaType === "image" && imageOptions
        ? await deps.provider.create(createRequest, imageOptions)
        : await deps.provider.create(createRequest);
      immediate = created.result;
      vendorTaskId = created.taskId;
      await deps.db.setTaskVendorId(job.id, vendorTaskId);
    }

    const start = Date.now();
    let p = immediate ?? await deps.provider.poll(vendorTaskId);
    for (;;) {
      await deps.updateProgress(job.id, p.progress);
      if (p.status === "completed") break;
      if (p.status === "failed") throw new GenerationError("GENERATION_FAILED", p.error ?? "generation failed");
      if (Date.now() - start > maxWaitMs) throw new GenerationError("TIMED_OUT", "generation timed out");
      await assertNotCancelled();
      await sleep(pollIntervalMs);
      p = await deps.provider.poll(vendorTaskId);
    }
    const sourceUrls = producedUrls(mediaType, input, p);
    if (!sourceUrls.length) throw new Error("generation completed without a url");
    await assertNotCancelled();

    return await downloadAndFinalize(deps, job, mediaType, sourceUrls, cacheKey, setMsg);
  } catch (err) {
    if (err instanceof JobCancelledError || deps.signal?.aborted) {
      await setMsg("cancelled", {});
      throw new JobCancelledError();
    } else {
      await setMsg("failed", { error: err instanceof Error ? err.message : String(err),
        ...(err instanceof ImageResultUnknown ? { errorCode: err.errorCode } : {}) });
    }
    throw err;
  }
}

async function pollToCompletion(deps: RunJobDeps, vendorTaskId: string, onProgress: (progress: number) => Promise<void>,
  assertNotCancelled: () => Promise<void>, immediate?: PollResult): Promise<PollResult> {
  const sleep = deps.sleep ?? realSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 3000;
  const maxWaitMs = deps.maxWaitMs ?? 15 * 60 * 1000;
  const start = Date.now();
  let p = immediate ?? await deps.provider.poll(vendorTaskId);
  for (;;) {
    await onProgress(p.progress);
    if (p.status === "completed") return p;
    if (p.status === "failed") throw new GenerationError("GENERATION_FAILED", p.error ?? "generation failed");
    if (Date.now() - start > maxWaitMs) throw new GenerationError("TIMED_OUT", "generation timed out");
    await assertNotCancelled();
    await sleep(pollIntervalMs);
    p = await deps.provider.poll(vendorTaskId);
  }
}

/**
 * One request per prompt, in order, each for a single image; the finished images are stored together as one
 * result. Submitted vendor ids are persisted after every request: a re-delivered job polls those and never
 * submits an image again. A request that fails stops the set (it would most likely fail again); images
 * already made are still kept, and the card says how many are missing.
 */
/**
 * Added in front of a set prompt when an image of the same set is the reference: the planner wrote the prompt without
 * a reference image, so say what the image is for and what not to copy from it.
 */
export const SET_REFERENCE_NOTE = "The attached reference image shows the product of this image set. Keep that product exactly "
  + "as it is: shape, color, proportions, logo, printed text and material. Do not copy its background, camera angle or layout; "
  + "follow the description below for those.\n\n";

type SetRequest = { size?: string; quality: string; media?: ReferenceMedia[] };

/**
 * One single-image request per prompt, in order, stopping at the first failure. Vendor ids are written to the task
 * before polling, so a re-delivered job only polls what it already paid for and never submits again.
 * `nextReference`, asked once before the second request, supplies a reference for the rest of the set.
 */
async function submitEach(
  deps: RunJobDeps,
  job: JobLike,
  prompts: string[],
  request: SetRequest,
  assertNotCancelled: () => Promise<void>,
  nextReference?: (firstUrl: string) => Promise<ReferenceMedia[] | undefined>
): Promise<{ sourceUrls: string[]; failure?: unknown }> {
  const persisted = parseSetVendorIds(await deps.db.getTaskVendorId(job.id));
  const resuming = !!persisted || !!await deps.hasImageReceipts?.();
  const vendorIds = persisted ?? [];
  const sourceUrls: string[] = [];
  let media = request.media;
  let referenced = false;
  for (let index = 0; index < prompts.length; index++) {
    let vendorTaskId: string | undefined = vendorIds[index];
    let immediate: PollResult | undefined;
    try {
      if (!vendorTaskId) {
        if (resuming) {
          if (!await deps.hasImageReceipt?.(index)) break;
          vendorTaskId = `receipt:${index}`;
        }
      }
      if (!vendorTaskId) {
        await assertNotCancelled();
        let prompt = prompts[index];
        if (index > 0 && nextReference && !media?.length && !referenced) {
          referenced = true;
          media = await nextReference(sourceUrls[0]);
          await assertNotCancelled();
        }
        if (referenced && media?.length) prompt = SET_REFERENCE_NOTE + prompt;
        console.log("[image.generate] set request", JSON.stringify({ taskId: job.id, model: deps.vendorModel, index, reference: !!media?.length }));
        const imageOptions = deps.signal || deps.hasImageReceipt || deps.hasImageReceipts
          ? { signal: deps.signal, slot: index } : undefined;
        const created = imageOptions
          ? await deps.provider.create({ prompt, size: request.size, n: 1, quality: request.quality, media }, imageOptions)
          : await deps.provider.create({ prompt, size: request.size, n: 1, quality: request.quality, media });
        immediate = created.result;
        vendorTaskId = created.taskId;
        vendorIds.push(vendorTaskId);
        await deps.db.setTaskVendorId(job.id, JSON.stringify(vendorIds));
      }
      const share = 100 / prompts.length;
      const done = await pollToCompletion(deps, vendorTaskId,
        (progress) => deps.updateProgress(job.id, Math.min(99, Math.round(index * share + progress * share / 100))), assertNotCancelled, immediate);
      await assertNotCancelled();
      const url = done.urls?.find(Boolean) ?? done.url;
      if (!url) throw new Error("generation completed without a url");
      sourceUrls.push(url);
    } catch (err) {
      if (err instanceof JobCancelledError || deps.signal?.aborted) throw err;
      return { sourceUrls, failure: err };
    }
  }
  return { sourceUrls };
}

/** An image as a reference for the rest of its set. Best effort: without it the set is still made, only less alike. */
async function setReference(taskId: string, resolve: () => Promise<string>): Promise<ReferenceMedia[] | undefined> {
  try {
    return [{ type: "reference_image", url: await resolve() }];
  } catch (err) {
    if (err instanceof JobCancelledError) throw err;
    console.warn("[image.generate] set reference unavailable", { taskId, errorType: (err as Error)?.name });
    return undefined;
  }
}

/**
 * Image sets (主副图 / 产品套图): each image has its own prompt and request. Without a reference from the user, the
 * first finished image becomes the reference for the rest, so every image shows the same product.
 */
async function runImageSet(
  deps: RunJobDeps,
  job: JobLike,
  prompts: string[],
  cacheKey: string | null,
  setMsg: (status: string, extra: Record<string, unknown>) => Promise<void>,
  assertNotCancelled: () => Promise<void>,
  request: SetRequest
): Promise<GenOut> {
  let firstAsset: Awaited<ReturnType<typeof storeGeneratedAsset>> | undefined;
  const firstAsReference = (firstUrl: string) => setReference(job.id, async () => {
    const file = await fetchProduced(deps, job.id, firstUrl);
    if (!usesImageReferenceUrls(deps.vendorModel)) return referenceDataUrl(file.body);
    await assertNotCancelled();
    firstAsset = await storeGeneratedAsset(deps, job, "image", file);
    return agentImageReferenceUrl(deps, firstAsset.asset.url);
  });
  const { sourceUrls, failure } = await submitEach(deps, job, prompts, request, assertNotCancelled, firstAsReference);
  if (!sourceUrls.length) throw failure ?? new Error("generation completed without a url");
  const partial = sourceUrls.length < prompts.length;
  const finalize = partial
    ? (status: string, extra: Record<string, unknown>) => setMsg(status, { ...extra, missing: prompts.length - sourceUrls.length,
      ...(failure instanceof ImageResultUnknown ? { error: failure.message, errorCode: failure.errorCode, unknownResult: true } : {}) })
    : setMsg;
  // A partial set is not cached: sending the same request again should try for the whole set.
  const out = await downloadAndFinalize(deps, job, "image", sourceUrls, partial ? null : cacheKey, finalize, firstAsset);
  return partial ? { ...out, missing: prompts.length - sourceUrls.length,
    ...(failure instanceof ImageResultUnknown ? { error: failure.message, unknownResult: true } : {}) } : out;
}

/** Queue job type of a 重做 / 补齐 request on a finished image set. */
export const IMAGE_REDO_TASK = "image.set_redo";

/** What a redo job changes on its set: which positions, with which prompts, and an image of the set to keep alike. */
interface ImageRedoInput {
  messageId: string;
  conversationId: string;
  indexes: number[];
  prompts: string[];
  /** Stored output URL of another image of the set; used only when the user gave no reference of their own. */
  setReference?: string;
}

function parseImageRedoInput(input: Record<string, unknown>): ImageRedoInput {
  const { redoMessageId, conversationId, indexes, prompts, setReference } = input;
  const valid = typeof redoMessageId === "string" && !!redoMessageId && typeof conversationId === "string" && !!conversationId
    && Array.isArray(indexes) && indexes.length > 0 && indexes.every((index) => Number.isInteger(index) && index >= 0)
    && Array.isArray(prompts) && prompts.length === indexes.length && prompts.every((prompt) => typeof prompt === "string" && !!prompt);
  if (!valid) throw new Error("invalid image redo input");
  return {
    messageId: redoMessageId as string, conversationId: conversationId as string, indexes: indexes as number[], prompts: prompts as string[],
    ...(typeof setReference === "string" && setReference ? { setReference } : {}),
  };
}

type StoredImage = { url: string; mime: string };

/** A running redo belongs to this job; the route writes the task id just after queueing, so a missing one is ours too. */
function ownsRedo(metadata: Record<string, unknown>, taskId: string): boolean {
  const redo = metadata.redo as { status?: unknown; taskId?: unknown } | undefined;
  return redo?.status === "running" && (redo.taskId === undefined || redo.taskId === taskId);
}

/**
 * Put redone images into a finished set: a position inside the set is replaced, the next position after it is
 * appended (filling a missing image). Composites were made from the old images, so they are dropped.
 * Returns null when this job no longer owns the set's redo (it was cancelled or replaced).
 */
export function applyImageRedo(
  metadata: Record<string, unknown>,
  taskId: string,
  indexes: number[],
  images: StoredImage[]
): Record<string, unknown> | null {
  if (!ownsRedo(metadata, taskId)) return null;
  const assets = Array.isArray(metadata.assets) ? [...metadata.assets] : [];
  let appended = 0;
  images.forEach((image, i) => {
    const index = indexes[i];
    if (index < assets.length) assets[index] = image;
    else if (index === assets.length) {
      assets.push(image);
      appended++;
    }
  });
  const { redo: _redo, composites: _composites, missing, ...rest } = metadata;
  const left = Math.max(0, (typeof missing === "number" ? missing : 0) - appended);
  return { ...rest, assets, ...(left > 0 ? { missing: left } : {}) };
}

/** End a redo that stored nothing: a failure stays on the card with its reason, a cancel just clears it. */
export function settleImageRedo(metadata: Record<string, unknown>, taskId: string, error?: string): Record<string, unknown> | null {
  if (!ownsRedo(metadata, taskId)) return null;
  const redo = metadata.redo as { indexes?: unknown };
  const { redo: _redo, ...rest } = metadata;
  return error ? { ...rest, redo: { status: "failed", taskId, indexes: redo.indexes, error } } : rest;
}

/**
 * 重做 / 补齐 for one finished image set: makes the images at `indexes` again with their original prompts and puts them
 * into the same message, so the set stays one set (and can still be composed). Started only by the user; a failed
 * image is never sent again on its own.
 */
export async function runImageSetRedo(deps: RunJobDeps, job: JobLike): Promise<GenOut> {
  const input = job.input;
  const redo = parseImageRedoInput(input);
  const update = deps.db.updateGenerationMetadata;
  if (!update) throw new Error("image redo needs updateGenerationMetadata");
  const owner = { conversationId: redo.conversationId, userId: job.userId };
  const change = (next: (metadata: Record<string, unknown>) => Record<string, unknown> | null) =>
    update.call(deps.db, redo.messageId, owner, next);
  const assertNotCancelled = async () => {
    if (deps.signal?.aborted) throw new JobCancelledError();
    if ((await deps.db.getTaskStatus(job.id)) === "cancelled") throw new JobCancelledError();
  };
  try {
    await assertNotCancelled();
    let media = await prepareImageReferences(deps, input.media as ReferenceMedia[] | undefined);
    let prompts = redo.prompts;
    const storedReference = redo.setReference;
    if (!media?.length && storedReference) {
      const read = deps.readOwnOutput;
      if (usesImageReferenceUrls(deps.vendorModel)) {
        media = await setReference(job.id, () => agentImageReferenceUrl(deps, storedReference));
      } else if (read) {
        media = await setReference(job.id, async () => referenceDataUrl((await read(storedReference)).body));
      }
      if (media?.length) prompts = prompts.map((prompt) => SET_REFERENCE_NOTE + prompt);
    }
    const request = { size: input.size as string | undefined, quality: (input.quality as string | undefined) ?? "auto", media };
    const { sourceUrls, failure } = await submitEach(deps, job, prompts, request, assertNotCancelled);
    if (!sourceUrls.length) throw failure ?? new Error("generation completed without a url");
    const files = [];
    for (const source of sourceUrls) files.push(await fetchProduced(deps, job.id, source));
    const assetIds: string[] = [];
    const images: StoredImage[] = [];
    for (const { body, mime } of files) {
      await assertNotCancelled();
      const stored = await storeGeneratedAsset(deps, job, "image", { body, mime });
      assetIds.push(stored.id);
      images.push(stored.asset);
    }
    await deps.meter.record({ userId: job.userId, taskId: job.id, modelId: deps.modelId, usage: { inputCount: 0, outputCount: images.length },
      idempotencyKey: `generation:${job.userId}:${job.id}` });
    await change((metadata) => {
      const next = applyImageRedo(metadata, job.id, redo.indexes.slice(0, images.length), images);
      return next && failure instanceof ImageResultUnknown ? { ...next, unknownResult: true, error: failure.message } : next;
    });
    await deps.updateProgress(job.id, 100);
    const missing = redo.indexes.length - images.length;
    return { assetIds, assets: images, ...(missing > 0 ? { missing } : {}) };
  } catch (err) {
    const cancelled = err instanceof JobCancelledError || !!deps.signal?.aborted;
    const message = cancelled ? undefined : err instanceof Error ? err.message : String(err);
    await change((metadata) => {
      const next = settleImageRedo(metadata, job.id, message);
      return next && err instanceof ImageResultUnknown ? { ...next, unknownResult: true } : next;
    });
    throw cancelled ? new JobCancelledError() : err;
  }
}

export async function redownloadGenerationJob(deps: RunJobDeps, job: JobLike, mediaType: MediaType): Promise<GenOut> {
  const input = job.input;
  const prompt = (input.prompt as string) ?? "";
  const sourceUrls = Array.isArray(input.sourceUrls) && input.sourceUrls.every((url) => typeof url === "string" && url)
    ? input.sourceUrls as string[]
    : typeof input.sourceUrl === "string" && input.sourceUrl ? [input.sourceUrl] : [];
  const setMsg = makeSetMsg(deps, job, mediaType, prompt);
  if (!sourceUrls.length) throw new Error("redownload requires a sourceUrl");
  if (deps.signal?.aborted) {
    await setMsg("cancelled", {});
    throw new JobCancelledError();
  }
  const output = await downloadAndFinalize(deps, job, mediaType, sourceUrls, null, setMsg);
  return { ...output, ...(typeof input.missing === "number" && input.missing > 0 ? { missing: input.missing } : {}),
    ...(input.unknownResult === true ? { unknownResult: true } : {}) };
}
