import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { fetchPublicBinary, ProviderError, type VideoGenerationProvider, type VideoGenerationRequest } from "@lot-agent/core";
import { COMIC_VIDEO_RESOLUTION, comicVideoModel, comicVideoProfile } from "@lot-agent/core/comic-drama";
import { definiteRejection, gatewayFailure } from "../marketing-video/run.js";
import type { createComicVideoCreditCheck } from "./credit-check.js";
import { withComicGenerationLock } from "./generation-worker.js";
import { COMIC_VIDEO_MAX_BYTES, type ComicMediaLibrary } from "./media-library.js";
import { PgComicVideo, type ComicVideoWork } from "./video-repository.js";

const sizes = {
  "480p": { "9:16": "480x854", "16:9": "854x480", "1:1": "480x480" },
  "720p": { "9:16": "720x1280", "16:9": "1280x720", "1:1": "720x720" },
  "768P": { "9:16": "768x1360", "16:9": "1360x768", "1:1": "768x768" },
  "1080p": { "9:16": "1080x1920", "16:9": "1920x1080", "1:1": "1080x1080" },
  "2K": { "9:16": "1152x2048", "16:9": "2048x1152", "1:1": "1440x1440" },
  "4k": { "9:16": "2160x3840", "16:9": "3840x2160", "1:1": "2160x2160" },
};
type Job = { id: string; userId: string };
type Dependencies = {
  pool: Pool;
  media: ComicMediaLibrary;
  provider: (owner: string, model: string) => Promise<VideoGenerationProvider>;
  checkCredits: ReturnType<typeof createComicVideoCreditCheck>;
  download?: typeof fetchPublicBinary;
  pollIntervalMs?: number;
  cancelIntervalMs?: number;
};

function vendorUrl(value: string | undefined) {
  const url = value ? URL.parse(value) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("VIDEO_OUTPUT_UNAVAILABLE");
  return url.href;
}

export async function prepareComicVideoRequest(
  media: Pick<ComicMediaLibrary, "videoReference">, owner: string, { input }: ComicVideoWork,
): Promise<VideoGenerationRequest> {
  const timed = input.timedReferences ?? [];
  const resolve = (kind: "audio" | "video") => Promise.all(timed.filter(ref => ref.kind === kind)
    .map(({ mediaId }) => media.videoReference(owner, mediaId, kind)));
  const [refs, first, last, audio, video] = await Promise.all([
    Promise.all(input.references.map(({ mediaId }) => media.videoReference(owner, mediaId))),
    input.firstFrame ? media.videoReference(owner, input.firstFrame.mediaId) : undefined,
    input.lastFrame ? media.videoReference(owner, input.lastFrame.mediaId) : undefined,
    resolve("audio"), resolve("video"),
  ]);
  const resolution = input.resolution ?? COMIC_VIDEO_RESOLUTION;
  const operation = input.mode === "edit" || input.mode === "extend" ? input.mode : "reference";
  const explicitTaskType = comicVideoModel(input.modelId)?.label === "Seedance 2.5";
  const adaptiveFrame = !!first && comicVideoProfile(input.modelId)?.adaptiveFrame;
  return {
    model: input.modelId, prompt: input.prompt, durationSec: input.durationMs / 1000,
    ...(adaptiveFrame ? { ratio: "adaptive" } : { size: sizes[resolution][input.aspectRatio], ratio: input.aspectRatio }),
    resolution, quality: resolution, generate_audio: !!audio.length,
    ...(refs.length ? { input_reference: refs } : {}), ...(first ? { first_frame: first } : {}), ...(last ? { last_frame: last } : {}),
    ...(audio.length ? { reference_audio: audio } : {}),
    ...(video.length ? { reference_video: video, seedanceReference: { operation, followsSource: !!input.sourceDuration, explicitTaskType } } : {}),
  };
}

async function submit(
  repo: PgComicVideo, deps: Dependencies, owner: string, take: ComicVideoWork, getProvider: () => Promise<VideoGenerationProvider>,
  signal: AbortSignal, takeSignal: AbortSignal, creditOverride: boolean,
) {
  deps.media.assertAvailable();
  const request = await prepareComicVideoRequest(deps.media, owner, take);
  takeSignal.throwIfAborted();
  const check = await deps.checkCredits(owner, take.input, takeSignal);
  takeSignal.throwIfAborted();
  if (check && (check.reason !== "insufficient" || !creditOverride)) {
    return await repo.pauseForCredits(owner, take.id, check) ? { paused: true } as const : undefined;
  }
  const provider = await getProvider();
  takeSignal.throwIfAborted();
  if (!await repo.claim(owner, take.id)) return;
  // A take cancel after this claim stops local work once the provider response is recorded.
  let created;
  try { created = await provider.create(request, { signal }); }
  catch (error) {
    const detail = error instanceof ProviderError ? error : null;
    // TokenHub returns this code from video admission or pre-consumption before it calls the vendor.
    if (detail?.code === "HTTP_ERROR" && detail.phase === "create"
      && detail.httpStatus === 403 && detail.vendorCode === "insufficient_user_quota") {
      return await repo.pauseAfterGatewayCreditRejection(owner, take.id, detail.gatewayRequestId) ? { paused: true } as const : undefined;
    }
    const rejected = definiteRejection(error) || gatewayFailure(error);
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
  return { vendorId: created.taskId };
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
    const submission = checkpoint.state === "unsubmitted"
      ? await submit(repo, deps, owner, take, getProvider, signal, takeSignal, checkpoint.creditOverride) : undefined;
    if (submission && "paused" in submission) return "credit-paused";
    const vendor = checkpoint.vendorId ?? submission?.vendorId;
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
      if (await takeWork(deps, repo, job.userId, take, signal) === "credit-paused") break;
    }
    return { takeCount: takes.length };
  });
}
