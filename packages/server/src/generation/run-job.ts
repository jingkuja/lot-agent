import { randomUUID } from "node:crypto";
import { genCacheKey } from "../billing/gen-cache.js";
import type { CreateResult, MediaType, PollResult, ReferenceMedia } from "@lot-agent/core";

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
type GenOut = { assetIds: string[]; assets: GenAssets };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runGenerationJob(deps: RunJobDeps, job: JobLike, mediaType: MediaType): Promise<GenOut> {
  const input = job.input;
  const prompt = (input.prompt as string) ?? "";
  const assistantMessageId = input.assistantMessageId as string | undefined;
  // Both id fields are server-injected by the generations route (the /tasks
  // route strips them). Without the conversation id there is nothing to scope
  // the update to, so no message write happens at all.
  const conversationId = input.conversationId as string | undefined;
  const media = input.media as ReferenceMedia[] | undefined;
  const baseMeta = {
    kind: "generation",
    mediaType,
    prompt,
    settings: { size: input.size, n: input.n, durationSec: input.durationSec, ratio: input.ratio },
  };
  const sleep = deps.sleep ?? realSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 3000;
  const maxWaitMs = deps.maxWaitMs ?? 15 * 60 * 1000;

  const setMsg = async (status: string, extra: Record<string, unknown>) => {
    if (assistantMessageId && conversationId) {
      await deps.db.updateMessageGeneration(
        assistantMessageId,
        { status, metadata: { ...baseMeta, status, ...extra } },
        { conversationId, userId: job.userId }
      );
    }
  };

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
      prompt, size: input.size, n: input.n, durationSec: input.durationSec, ratio: input.ratio,
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
      const created = await deps.provider.create({
        prompt,
        size: input.size as string | undefined,
        n: input.n as number | undefined,
        durationSec: input.durationSec as number | undefined,
        ratio: input.ratio as string | undefined,
        media,
      });
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

    const { body, mime } = await deps.urlToBytes(p.url, { signal: deps.signal });
    const assetId = randomUUID();
    const key = `${assetId}.${deps.extFor(mime)}`;
    const { url } = await deps.storage.put({ key, body, contentType: mime });
    const durationSec = mediaType === "video" ? Number(input.durationSec ?? 5) : undefined;
    await deps.db.createAsset({ id: assetId, taskId: job.id, userId: job.userId, type: mediaType, storageKey: key, url, mime, sizeBytes: body.byteLength, durationSec });
    await deps.meter.record({ userId: job.userId, taskId: job.id, modelId: deps.modelId, usage: { inputCount: 0, outputCount: mediaType === "video" ? (durationSec ?? 1) : 1 } });
    const assets: GenAssets = [durationSec != null ? { url, mime, durationSec } : { url, mime }];
    const out: GenOut = { assetIds: [assetId], assets };
    await deps.cache.set(cacheKey, out);
    await setMsg("completed", { assets });
    await deps.updateProgress(job.id, 100);
    return out;
  } catch (err) {
    if (err instanceof JobCancelledError) {
      await setMsg("cancelled", {});
    } else {
      await setMsg("failed", { error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}
