import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderError, VideoGenerationProvider, VideoGenerationRequest } from "@lot-agent/core";
import { presenterTrackMs, PRESENTER_INPUT_VERSION, type PresenterDraft } from "@lot-agent/core/digital-presenter";
import type { DB } from "../db/database.js";
import { JobCancelledError } from "../generation/run-job.js";
import { inspectMedia, mediaCapabilities, ownedAssetPath } from "../marketing-video/media.js";
import { definiteRejection } from "../marketing-video/run.js";
import { PresenterRunError, UNKNOWN_CLIP_MESSAGE } from "./errors.js";
import { presenterFile, presenterPath, signPresenterFile } from "./files.js";
import { buildTrack, composeImageMode, composeVideoMode, portraitFrame, prepareFace, prepareFootage, preparePortrait } from "./media.js";
import { presenterLockKey, PgPresenterStore, type ClipRow } from "./repository.js";
import type { FrozenTake } from "./takes.js";

/** The job input frozen at submission. Takes are files that are never replaced. */
export interface PresenterJobInput {
  presenterInputVersion: number; projectId: string; mode: PresenterDraft["mode"]; model: string;
  resolution: PresenterDraft["resolution"]; ratio: PresenterDraft["ratio"];
  takes: FrozenTake[]; portrait?: string; baseVideo?: string; faceReference?: string;
}

export interface PresenterRunDeps {
  db: DB; dataRoot: string;
  /** Bound to the owner's own model key: the gateway bills the owner. */
  provider(userId: string, model: string): Promise<VideoGenerationProvider>;
  /** SSRF-guarded, size-capped download of a vendor result. */
  download(url: string, signal: AbortSignal): Promise<{ body: Buffer; mime: string }>;
  storage: { put(a: { key: string; body: Buffer; contentType: string }): Promise<{ url: string }> };
  clipConcurrency?: number; pollIntervalMs?: number; maxWaitMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  compose?: { image: typeof composeImageMode; video: typeof composeVideoMode };
  sign?: typeof signPresenterFile;
}

const sleeper = (ms: number, signal: AbortSignal) => new Promise<void>(done => {
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

function frozenInput(value: Record<string, unknown>): PresenterJobInput {
  const input = value as unknown as PresenterJobInput;
  const takes = Array.isArray(input.takes) ? input.takes : [];
  if (input.presenterInputVersion !== PRESENTER_INPUT_VERSION || !["image", "video"].includes(input.mode) || typeof input.model !== "string" || !takes.length
    || takes.some((take, slot) => !take || take.slot !== slot || typeof take.file !== "string" || !Number.isInteger(take.durationMs) || take.durationMs <= 0)
    || (input.mode === "image" ? !input.portrait : !input.baseVideo)) throw new PresenterRunError("NOT_RECOVERABLE", "生成任务配置不完整");
  return { ...input, takes };
}

export async function runDigitalPresenter(deps: PresenterRunDeps, job: { id: string; userId: string; input: Record<string, unknown> }, signal: AbortSignal) {
  const connection = await deps.db.pool.connect();
  const lockKey = presenterLockKey(job.id);
  let locked = false;
  const controller = new AbortController();
  const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    locked = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lockKey])).rows[0].locked;
    if (!locked) throw new PresenterRunError("JOB_BUSY", "该视频正在处理，请稍后查询原任务。");
    const store = new PgPresenterStore(deps.db.pool);
    const input = frozenInput(job.input);
    const project = await store.get(job.userId, input.projectId);
    if (!project || project.taskId !== job.id) throw new PresenterRunError("NOT_RECOVERABLE", "视频任务不存在");
    const assertActive = async () => {
      if (controller.signal.aborted || await deps.db.getTaskStatus(job.id) === "cancelled") { abort(); throw new JobCancelledError(); }
    };
    timer = setInterval(() => { void assertActive().catch(abort); }, 1000);
    await assertActive();
    const existing = (await deps.db.pool.query("SELECT * FROM assets WHERE task_id=$1 AND user_id=$2 AND type='video' ORDER BY created_at LIMIT 1", [job.id, job.userId])).rows[0];
    if (existing) return { assetIds: [existing.id], assets: [{ url: existing.url, mime: existing.mime, durationSec: Number(existing.duration_sec) || undefined }] };

    const clips = await store.clips(job.id);
    const expected = input.mode === "image" ? input.takes.length : 1;
    if (clips.length !== expected || clips.some((clip, slot) => clip.slot !== slot || clip.model !== input.model)) throw new PresenterRunError("NOT_RECOVERABLE", "生成任务配置不完整");
    // Never send a fresh paid request while a sibling's submission outcome is unknown.
    if (clips.some(clip => clip.status === "submitting")) throw new PresenterRunError("SUBMISSION_UNKNOWN", UNKNOWN_CLIP_MESSAGE);
    let takes: string[];
    try { takes = await Promise.all(input.takes.map(take => presenterFile(deps.dataRoot, input.projectId, take.file))); }
    catch { throw new PresenterRunError("NOT_RECOVERABLE", "配音文件已不可用，请复制为新草稿并重新生成配音。"); }
    // The API host's probe says nothing about this worker. Stop before any clip is paid for.
    if (!(await mediaCapabilities()).composition) throw new PresenterRunError("CONFIG_MISSING", "视频合成工具不可用，请配置 FFmpeg 和 FFprobe。");

    const jobFile = (name: string) => `jobs/${job.id}/${name}`;
    const local = (name: string) => presenterPath(deps.dataRoot, input.projectId, jobFile(name));
    await mkdir(dirname(local("x.wav")), { recursive: true });
    const trackMs = presenterTrackMs(input.takes.map(take => take.durationMs));
    const owned = async (id: string | undefined, label: string) => {
      const asset = id ? await deps.db.getAsset(id) : null;
      if (!asset || asset.user_id !== job.userId || asset.type !== "upload") throw new PresenterRunError("INPUT_INVALID", `${label}不存在，请复制为新草稿并重新选择。`);
      try { return await ownedAssetPath(deps.dataRoot, asset); }
      catch { throw new PresenterRunError("INPUT_INVALID", `${label}不可用，请复制为新草稿并重新选择。`); }
    };
    /** Each prepared input is written once per job: a vendor may still be reading it through a
     * link bound to its content hash. A partial file from a stopped worker is never used. */
    const prepare = async (name: string, work: (output: string) => Promise<unknown>) => {
      if (await access(local(name)).then(() => true, () => false)) return;
      const part = local(name.replace(/\.(\w+)$/, "-part.$1"));
      try { await work(part); await rename(part, local(name)); }
      catch (error) {
        await rm(part, { force: true });
        if (controller.signal.aborted) throw new JobCancelledError();
        throw error instanceof PresenterRunError ? error : new PresenterRunError("INPUT_INVALID", error instanceof Error ? error.message : "素材处理失败", { cause: error });
      }
    };
    // Video mode: the voice track is the job's audio, built from the frozen takes.
    let trackSec = trackMs / 1000;
    if (input.mode === "video") {
      await prepare("track.wav", output => buildTrack(takes, output, controller.signal));
      trackSec = (await inspectMedia(local("track.wav"), controller.signal)).duration;
    }
    if (clips.some(clip => clip.status === "pending" || clip.status === "failed")) {
      // Inputs are prepared before any clip is paid for.
      await deps.db.updateTaskProgress(job.id, 2, "正在准备素材");
      if (input.mode === "image") await prepare("portrait.jpg", async output => preparePortrait(await owned(input.portrait, "人物肖像"), output, input.ratio, controller.signal));
      else {
        await prepare("footage.mp4", async output => prepareFootage(await owned(input.baseVideo, "口播底片"), output, trackSec, controller.signal));
        if (input.faceReference) await prepare("face.jpg", async output => prepareFace(await owned(input.faceReference, "人脸参考图"), output, controller.signal));
      }
    }
    await assertActive();

    const provider = await deps.provider(job.userId, input.model);
    const sign = deps.sign ?? signPresenterFile;
    const progress: number[] = clips.map(clip => clip.status === "succeeded" ? 100 : 0);
    const report = () => deps.db.updateTaskProgress(job.id, Math.floor(5 + progress.reduce((a, b) => a + b, 0) / clips.length * 0.85),
      `片段完成 ${progress.filter(p => p === 100).length}/${clips.length}`);
    const setClip = (slot: number, fields: string, values: unknown[], where = "") =>
      deps.db.pool.query(`UPDATE digital_presenter_clips SET ${fields},updated_at=now() WHERE task_id=$1 AND slot=$2${where}`, [job.id, slot, ...values]);

    const request = async (clip: ClipRow): Promise<VideoGenerationRequest> => {
      const url = (name: string) => sign(deps.dataRoot, input.projectId, name);
      if (input.mode === "image") {
        const take = input.takes[clip.slot];
        return { prompt: "", model: input.model, resolution: input.resolution, durationSec: take.durationMs / 1000,
          input_reference: await url(jobFile("portrait.jpg")), reference_audio: await url(take.file) };
      }
      return { prompt: "", model: input.model, durationSec: trackSec, reference_video: await url(jobFile("footage.mp4")),
        reference_audio: await url(jobFile("track.wav")), ...(input.faceReference ? { input_reference: await url(jobFile("face.jpg")) } : {}) };
    };

    const runClip = async (clip: ClipRow) => {
      let vendorId = clip.vendor_task_id;
      if (clip.status === "succeeded") {
        try { await presenterFile(deps.dataRoot, input.projectId, clip.file); return; }
        catch { throw new PresenterRunError("NOT_RECOVERABLE", "已生成的片段文件丢失，请复制为新草稿重新制作。"); }
      }
      if (clip.status !== "running" || !vendorId) {
        // Signing reads the inputs, so a missing file fails here, before the intent is recorded.
        let body: VideoGenerationRequest;
        try { body = await request(clip); }
        catch (error) { throw new PresenterRunError("CONFIG_MISSING", error instanceof Error ? error.message : "素材链接生成失败", { cause: error }); }
        await assertActive();
        const claim = await setClip(clip.slot, "status='submitting',error=NULL,vendor_task_id=NULL", [], " AND status IN ('pending','failed')");
        if (!claim.rowCount) throw new PresenterRunError("SUBMISSION_UNKNOWN", UNKNOWN_CLIP_MESSAGE);
        let created;
        try { created = await provider.create(body); }
        catch (error) {
          // An explicit rejection created nothing; the clip may be submitted again after a fix.
          if (definiteRejection(error)) {
            const { httpStatus: status, vendorCode, requestId } = error as ProviderError;
            console.warn("[digital-presenter] clip rejected", { taskId: job.id, slot: clip.slot, model: input.model, httpStatus: status, vendorCode, upstreamRequestId: requestId });
            await setClip(clip.slot, "status='failed',error=$3", [`${(error as Error).message}${vendorCode ? ` ${vendorCode}` : ""}`.slice(0, 300)]);
            throw new PresenterRunError("REJECTED", status === 401 || status === 402 || status === 403 ? "模型账号余额不足或未开通数字人视频模型。" : status === 429 ? "视频模型繁忙，请稍后继续生成。" : "视频模型拒绝了本次请求，请检查肖像、底片或配音后继续生成。", { cause: error });
          }
          throw new PresenterRunError("SUBMISSION_UNKNOWN", UNKNOWN_CLIP_MESSAGE, { cause: error });
        }
        if (!created.taskId) throw new PresenterRunError("SUBMISSION_UNKNOWN", UNKNOWN_CLIP_MESSAGE);
        vendorId = created.taskId;
        await setClip(clip.slot, "status='running',vendor_task_id=$3", [vendorId]);
        console.log("[digital-presenter] clip submitted", { taskId: job.id, slot: clip.slot, model: input.model, vendorTaskId: vendorId });
      }
      const started = Date.now();
      for (;;) {
        await assertActive();
        let result;
        try { result = await provider.poll(vendorId); }
        catch (error) { throw new PresenterRunError("STATUS_UNCONFIRMED", "片段状态暂时无法确认，继续生成将查询原片段。", { cause: error }); }
        if (result.failureUnconfirmed) throw new PresenterRunError("STATUS_UNCONFIRMED", "片段状态暂时无法确认，继续生成将查询原片段。");
        progress[clip.slot] = Math.min(95, Math.max(progress[clip.slot], Number(result.progress) || 0));
        await report();
        if (result.status === "failed") {
          await setClip(clip.slot, "status='failed',error=$3", [(result.error ?? "generation failed").slice(0, 300)]);
          throw new PresenterRunError("GENERATION_FAILED", `第 ${clip.slot + 1} 段生成失败，请检查肖像或底片是否为清晰的单人正脸后继续生成。`);
        }
        if (result.status === "completed") {
          if (!result.url) throw new PresenterRunError("STATUS_UNCONFIRMED", "片段已完成但未返回视频地址，继续生成将查询原片段。");
          const name = jobFile(`clip-${clip.slot}-${randomUUID().slice(0, 8)}.mp4`);
          const path = presenterPath(deps.dataRoot, input.projectId, name);
          try {
            const { body } = await deps.download(result.url, controller.signal);
            await writeFile(path, body);
            const info = await inspectMedia(path, controller.signal);
            if (!info.video || info.duration < 0.5) throw new Error("clip incomplete");
            await setClip(clip.slot, "status='succeeded',file=$3,seconds=$4,error=NULL", [name, info.duration]);
          } catch (error) {
            await rm(path, { force: true });
            if (controller.signal.aborted) throw new JobCancelledError();
            // The vendor link stays valid for 24 hours; continuing polls and downloads again.
            throw new PresenterRunError("DOWNLOAD_INCOMPLETE", "片段已生成，下载未完成；继续生成将重新下载原片段。", { cause: error });
          }
          progress[clip.slot] = 100; await report();
          return;
        }
        if (Date.now() - started > (deps.maxWaitMs ?? 45 * 60_000)) throw new PresenterRunError("TIMED_OUT", "片段等待时间过长，继续生成将查询原片段。");
        await (deps.sleep ?? sleeper)(deps.pollIntervalMs ?? 10_000, controller.signal);
      }
    };

    await report();
    let next = 0; let failure: unknown;
    const work = async () => {
      while (!failure && next < clips.length) {
        const clip = clips[next++];
        try { await runClip(clip); } catch (error) { failure ??= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(deps.clipConcurrency ?? 2, clips.length) }, work));
    if (failure) throw failure;
    await assertActive();
    await deps.db.updateTaskProgress(job.id, 92, "正在合成视频");
    const done = await store.clips(job.id);
    const files = await Promise.all(done.map(clip => presenterFile(deps.dataRoot, input.projectId, clip.file)));
    let result;
    try {
      result = input.mode === "image"
        ? await (deps.compose?.image ?? composeImageMode)({ clips: files, takes, takeMs: input.takes.map(take => take.durationMs), frame: portraitFrame(input.ratio, input.resolution), signal: controller.signal })
        : await (deps.compose?.video ?? composeVideoMode)({ clip: files[0], track: local("track.wav"), trackSec, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new JobCancelledError();
      throw new PresenterRunError("COMPOSITION_FAILED", error instanceof Error ? error.message : "视频合成失败", { cause: error });
    }
    await assertActive();
    const id = randomUUID(); const key = `${id}.mp4`;
    const { url } = await deps.storage.put({ key, body: result.body, contentType: "video/mp4" });
    await deps.db.createAsset({ id, taskId: job.id, userId: job.userId, type: "video", storageKey: key, url, mime: "video/mp4", sizeBytes: result.body.length, durationSec: result.durationSec, width: result.width, height: result.height });
    return { assetIds: [id], assets: [{ url, mime: "video/mp4", durationSec: result.durationSec }] };
  } catch (error) {
    if (error instanceof JobCancelledError || error instanceof PresenterRunError) throw error;
    throw new PresenterRunError("UNKNOWN", error instanceof Error ? error.message : String(error), { cause: error });
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener("abort", abort);
    try { if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]); }
    finally { connection.release(); }
  }
}
