import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { fetchPublicBinary, ProviderError, type VideoGenerationProvider, type VideoGenerationRequest } from "@lot-agent/core";
import { definiteRejection, gatewayFailure } from "../marketing-video/run.js";
import { withComicGenerationLock } from "./generation-worker.js";
import { COMIC_VIDEO_MAX_BYTES, type ComicMediaLibrary } from "./media-library.js";
import { PgComicVideo, type ComicVideoWork } from "./video-repository.js";

const sizes = { "9:16": "720x1280", "16:9": "1280x720", "1:1": "720x720" };
type Job = { id: string; userId: string };
type Dependencies = {
  pool: Pool;
  media: ComicMediaLibrary;
  provider: (owner: string, model: string) => Promise<VideoGenerationProvider>;
  download?: typeof fetchPublicBinary;
  pollIntervalMs?: number;
  cancelIntervalMs?: number;
};

function vendorUrl(value: string | undefined) {
  const url = value ? URL.parse(value) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("VIDEO_OUTPUT_UNAVAILABLE");
  return url.href;
}

async function prepareRequest(media: ComicMediaLibrary, owner: string, { input }: ComicVideoWork): Promise<VideoGenerationRequest> {
  const [refs, first] = await Promise.all([
    Promise.all(input.references.map(({ mediaId }) => media.videoReference(owner, mediaId))),
    input.firstFrame ? media.videoReference(owner, input.firstFrame.mediaId) : undefined,
  ]);
  return {
    model: input.modelId, prompt: input.prompt, durationSec: input.durationMs / 1000,
    size: sizes[input.aspectRatio], ratio: input.aspectRatio, resolution: "720p", quality: "720p", generate_audio: false,
    ...(refs.length ? { input_reference: refs } : {}), ...(first ? { first_frame: first } : {}),
  };
}

async function submit(
  repo: PgComicVideo, deps: Dependencies, owner: string, take: ComicVideoWork, provider: VideoGenerationProvider,
  signal: AbortSignal, takeSignal: AbortSignal,
) {
  deps.media.assertAvailable();
  const request = await prepareRequest(deps.media, owner, take);
  takeSignal.throwIfAborted();
  if (!await repo.claim(owner, take.id)) return;
  // A take cancel after this claim stops local work once the provider response is recorded.
  let created;
  try { created = await provider.create(request, { signal }); }
  catch (error) {
    const rejected = definiteRejection(error) || gatewayFailure(error);
    const detail = error instanceof ProviderError ? error : null;
    const code = rejected ? gatewayFailure(error) ? "VIDEO_GATEWAY_FAILED" : detail?.code === "REAL_PERSON_REJECTED"
      ? "REAL_PERSON_REJECTED" : "VIDEO_GENERATION_REJECTED" : "VIDEO_SUBMISSION_UNKNOWN";
    await repo.submissionFailed(owner, take.id, rejected, code, detail?.gatewayRequestId, detail?.httpStatus);
    return;
  }
  const trace = created.gatewayRequestId;
  if (!/^[\w.:-]{1,250}$/.test(created.taskId)) {
    await repo.submissionFailed(owner, take.id, false, "VIDEO_SUBMISSION_UNKNOWN", trace);
    return;
  }
  await repo.accepted(owner, take.id, created.taskId, trace);
  return created.taskId;
}

async function takeWork(deps: Dependencies, repo: PgComicVideo, owner: string, take: ComicVideoWork, signal: AbortSignal) {
  const checkpoint = await repo.start(owner, take.id);
  if (!checkpoint) return;
  if (checkpoint.state === "unknown" || checkpoint.state === "submitting") {
    await repo.submissionFailed(owner, take.id, false, "VIDEO_SUBMISSION_UNKNOWN", checkpoint.gatewayRequestId ?? undefined);
    return;
  }
  const controller = new AbortController();
  const takeSignal = AbortSignal.any([controller.signal, signal]);
  const observe = async () => { if (await repo.stopped(owner, take.id)) controller.abort(); };
  const timer = setInterval(() => void observe().catch(() => controller.abort()), deps.cancelIntervalMs ?? 1000);
  timer.unref();
  let provider: VideoGenerationProvider | undefined;
  const getProvider = async () => provider ??= await deps.provider(owner, take.input.modelId);
  const lookup = async (vendor: string) => {
    const pollSignal = AbortSignal.any([takeSignal, AbortSignal.timeout(8 * 60_000)]);
    for (;;) {
      pollSignal.throwIfAborted();
      const result = await (await getProvider()).poll(vendor, { signal: pollSignal });
      if (result.failureUnconfirmed) throw new Error("VIDEO_STATUS_UNCONFIRMED");
      if (result.status === "failed") {
        await repo.mark(owner, take.id, "failed", result.realPerson ? "REAL_PERSON_REJECTED" : "VIDEO_GENERATION_FAILED");
        return;
      }
      if (result.status === "completed") {
        const url = vendorUrl(result.url ?? result.urls?.[0]);
        await repo.output(owner, take.id, url);
        return url;
      }
      await repo.progress(owner, take.id, result.progress);
      await delay(deps.pollIntervalMs ?? 5000, undefined, { signal: pollSignal });
    }
  };
  const download = (url: string) => (deps.download ?? fetchPublicBinary)(url, { maxBytes: COMIC_VIDEO_MAX_BYTES, timeoutMs: 120_000, signal: takeSignal });

  try {
    await observe();
    takeSignal.throwIfAborted();
    const vendor = checkpoint.vendorId ?? await submit(repo, deps, owner, take, await getProvider(), signal, takeSignal);
    if (!vendor) return;
    const url = checkpoint.outputUrl ?? await lookup(vendor);
    if (!url) return;
    takeSignal.throwIfAborted();
    let output;
    try { output = await download(url); }
    catch (error) {
      const status = (error as { status?: number } | null)?.status;
      if (!checkpoint.outputUrl || ![401, 403, 404, 410].includes(status ?? 0)) throw error;
      const refreshed = await lookup(vendor);
      if (!refreshed) return;
      output = await download(refreshed);
    }
    const request = new Request("http://comic-drama.invalid/generated-video", {
      method: "POST", body: new Uint8Array(output.body), signal: takeSignal, headers: { "Content-Type": "video/mp4" },
    });
    await deps.media.upload(request, owner, "generated-video", media => repo.save(owner, take.id, media));
  } catch {
    const receipt = await repo.receipt(owner, take.id);
    if (receipt.state === "submitting") {
      await repo.submissionFailed(owner, take.id, false, "VIDEO_SUBMISSION_UNKNOWN", receipt.gatewayRequestId ?? undefined);
    } else {
      const error = takeSignal.aborted ? "VIDEO_PROCESSING_STOPPED" : receipt.state === "output" ? "VIDEO_DOWNLOAD_REQUIRED" : "VIDEO_RECOVERY_REQUIRED";
      await repo.mark(owner, take.id, "recoverable", error);
    }
  } finally { clearInterval(timer); }
}

export async function runComicVideoGeneration(deps: Dependencies, job: Job, signal: AbortSignal) {
  const repo = new PgComicVideo(deps.pool);
  return withComicGenerationLock(deps.pool, job.id, async () => {
    const takes = await repo.work(job.userId, job.id);
    for (const take of takes) {
      signal.throwIfAborted();
      await takeWork(deps, repo, job.userId, take, signal);
    }
    return { takeCount: takes.length };
  });
}
