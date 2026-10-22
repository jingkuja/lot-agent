import { randomUUID } from "node:crypto";
import { ProviderError, type ReferenceInput } from "@lot-agent/core";
import { marketingJobProfile, marketingReferenceError, marketingShotMaxSeconds, MarketingDraftSchema, resolveMarketingSegments, isMarketingDurationValid, type MarketingSegment } from "@lot-agent/core/marketing-video";
import type { DB } from "../db/database.js";
import { JobCancelledError, runGenerationJob, type RunJobDeps } from "../generation/run-job.js";
import { PgMarketingProjectStore } from "./repository.js";
import { composeMarketingVideo, inspectMedia, mediaCapabilities, ownedAssetPath, SUBTITLES_UNAVAILABLE } from "./media.js";
import { marketingSegmentPrompt } from "./prompt.js";
import { segmentRecoveryAction, UNKNOWN_SUBMISSION, UNKNOWN_SUBMISSION_MESSAGE } from "./recovery.js";
import { marketingFailureCode, MarketingRunError } from "./failure.js";
import { publicStaticUrl } from "../util/public-base.js";
import { frozenNarration, narrationFile } from "./narration.js";

const UNKNOWN = UNKNOWN_SUBMISSION;
// 4xx answers reject the request itself; 408/409 may still have created a task (5xx: see gatewayFailure).
// CONNECT_ERROR means the POST was never written, so no vendor task can exist.
const REJECTED_STATUS = new Set([400, 401, 402, 403, 404, 413, 422, 429]);
export function definiteRejection(error: unknown) {
  return error instanceof ProviderError && error.phase === "create"
    && (error.code === "REAL_PERSON_REJECTED" || error.code === "CONNECT_ERROR" || (error.code === "HTTP_ERROR" && REJECTED_STATUS.has(error.httpStatus ?? 0)));
}
/** A gateway 5xx to a clip submission counts as not charged, like the marketing text
 * requests: the clip is resubmitted on the next continue without a duplicate-charge
 * confirmation, and its gateway request ID is kept to refund a rare real charge. */
export function gatewayFailure(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.phase === "create" && error.code === "HTTP_ERROR" && (error.httpStatus ?? 0) >= 500;
}
export const GATEWAY_FAILED_MESSAGE = "视频模型服务暂时出错，该片段没有生成；继续生成会重新提交该片段。";
export interface MarketingRunDeps {
  db: DB; dataRoot: string;
  generation(job: { userId: string; input: Record<string, unknown> }, signal: AbortSignal): Promise<RunJobDeps>;
  compose?: typeof composeMarketingVideo;
  /** Clips submitted and polled at once within this render (MARKETING_VIDEO_SEGMENT_CONCURRENCY). */
  segmentConcurrency?: number;
}
export async function runMarketingVideo(deps: MarketingRunDeps, job: { id: string; userId: string; input: Record<string, unknown> }, signal: AbortSignal) {
  const connection = await deps.db.pool.connect();
  const lockKey = `marketing:${job.id}`;
  let locked = false;
  const controller = new AbortController();
  const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    locked = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lockKey])).rows[0].locked;
    if (!locked) throw new MarketingRunError("JOB_BUSY", "该视频正在处理，请稍后查询原任务。");
    const store = new PgMarketingProjectStore(deps.db.pool);
    const project = await store.get(job.userId, String(job.input.projectId));
    if (!project || project.taskId !== job.id) throw new MarketingRunError("NOT_RECOVERABLE", "视频任务不存在");
    const assertActive = async () => {
      if (controller.signal.aborted || await deps.db.getTaskStatus(job.id) === "cancelled") { abort(); throw new JobCancelledError(); }
    };
    timer = setInterval(() => { void assertActive().catch(abort); }, 1000);
    await assertActive();
    const existing = (await deps.db.pool.query("SELECT * FROM assets WHERE task_id=$1 AND user_id=$2 ORDER BY created_at LIMIT 1", [job.id, job.userId])).rows[0];
    if (existing) return { assetIds: [existing.id], assets: [{ url: existing.url, mime: existing.mime }] };
    const draft = MarketingDraftSchema.parse(job.input.draft);
    // Persisted provider options govern recovery, including pre-v2 jobs that
    // allowed WebM plus native narration. Never infer audio from today's draft.
    const generateAudio = job.input.generate_audio !== false;
    // Clips of jobs submitted with this flag carry no text; captions are burned in locally.
    const localSubtitles = job.input.local_subtitles === true;
    const inputVersion = typeof job.input.marketingInputVersion === "number" ? job.input.marketingInputVersion : 1;
    // The frozen model's rules apply; version 1 inputs predate reference checks.
    const profile = marketingJobProfile(job.input);
    const referenceError = inputVersion >= 2 ? marketingReferenceError(draft, profile) : "";
    if (referenceError) throw new MarketingRunError("NOT_RECOVERABLE", referenceError);
    const segments = (await store.segments(job.userId, project.id)).map(segment => ({ ...segment, duration_sec: Number(segment.duration_sec) }));
    // Stop the entire mixed batch before any fresh paid intent if a sibling's
    // submission result is still unknown.
    if (segments.some(segment => segmentRecoveryAction(segment) === "unknown")) throw new MarketingRunError("SUBMISSION_UNKNOWN", UNKNOWN_SUBMISSION_MESSAGE);
    // Persisted boundaries are authoritative, including legacy jobs without a
    // storyboard. Never re-plan an already submitted video during recovery.
    // Check the full paid duration before resolving providers or sending a clip.
    if (!segments.length || segments.length > 15 || segments.some((s, i) => s.slot !== i || !Number.isInteger(s.duration_sec) || s.duration_sec < 4 || s.duration_sec > marketingShotMaxSeconds(draft, profile))
      || !isMarketingDurationValid(draft.durationSec, segments.reduce((sum, s) => sum + s.duration_sec, 0))) throw new MarketingRunError("NOT_RECOVERABLE", "视频分段配置不完整");
    if (draft.storyboard.length) {
      const planned = resolveMarketingSegments(draft, profile);
      if (planned.length !== segments.length || planned.some((p, i) => p.script !== segments[i].script || p.durationSec !== segments[i].duration_sec)) throw new MarketingRunError("NOT_RECOVERABLE", "视频分段配置不完整");
    } else if (segments.map(s => s.script).join("").trim() !== draft.script.trim()) throw new MarketingRunError("NOT_RECOVERABLE", "视频分段配置不完整");
    // Validate every remaining submission before any segment incurs a model or voice charge.
    // Completed/resumable vendor tasks keep using their original submitted prompts.
    let prompts: (string | undefined)[];
    try {
      prompts = segments.map((segment, index) => segmentRecoveryAction(segment) === "submit"
        ? marketingSegmentPrompt(draft, { index, script: segment.script, durationSec: segment.duration_sec }, segments.length, generateAudio, profile, localSubtitles) : undefined);
    } catch (error) { throw new MarketingRunError("NOT_RECOVERABLE", (error as Error).message); }
    // Twin narration (version 4) was synthesized and confirmed before submission. Check the
    // frozen takes before any clip is paid for; a missing file cannot be recreated here.
    let narration: string[] | undefined;
    if (inputVersion >= 4 && job.input.narration !== undefined) {
      try {
        const takes = frozenNarration(job.input.narration, segments.length);
        narration = await Promise.all(takes.map(take => narrationFile(deps.dataRoot, project.id, take.storageKey)));
      } catch { throw new MarketingRunError("NARRATION_INVALID", "配音文件已不可用，请复制为新草稿并重新生成配音。"); }
    }
    // The API host's probe says nothing about this worker. Stop before any voice or clip is paid for.
    const capabilities = await mediaCapabilities();
    if (!capabilities.composition) throw new MarketingRunError("CONFIG_MISSING", "视频合成工具不可用，请配置 FFmpeg 和 FFprobe。");
    const burnSubtitles = localSubtitles && draft.subtitles && !!narration;
    if (burnSubtitles && !capabilities.subtitles) throw new MarketingRunError("CONFIG_MISSING", SUBTITLES_UNAVAILABLE);
    // Kling: create each voice sample once per parent job, before clips run in
    // parallel, so clips never race to POST it. Clips that already hold a
    // per-clip voice checkpoint (jobs started before this change) keep it.
    const legacyVoiceClips = new Set<string>();
    const referenceAudio = generateAudio ? job.input.reference_audio as ReferenceInput | undefined : undefined;
    const freshClips = segments.filter(segment => segmentRecoveryAction(segment) === "submit").map(segment => segment.task_id as string);
    if (referenceAudio?.length && freshClips.length) {
      const voiceGen = await deps.generation(job, controller.signal);
      if (/kling/i.test(voiceGen.vendorModel)) {
        const { rows } = await deps.db.pool.query("SELECT DISTINCT task_id FROM generation_voice_tasks WHERE task_id::text=ANY($1::text[]) AND user_id=$2", [freshClips, job.userId]);
        for (const row of rows) legacyVoiceClips.add(String(row.task_id));
        if (freshClips.some(id => !legacyVoiceClips.has(id))) {
          if (!voiceGen.prepareKlingVoices) throw new MarketingRunError("CONFIG_MISSING", "Kling 音色服务未配置，无法提交参考声音。");
          await voiceGen.prepareKlingVoices({ taskId: job.id, userId: job.userId, signal: controller.signal, assertNotCancelled: assertActive, resolveReferenceUrl: voiceGen.resolveReferenceUrl,
            referenceAudio: typeof referenceAudio === "string" ? publicStaticUrl(referenceAudio) : referenceAudio.map(publicStaticUrl) });
        }
      }
    }
    const progress: number[] = segments.map((s) => s.status === "succeeded" ? 100 : 0);
    const report = async () => deps.db.updateTaskProgress(job.id, Math.floor(progress.reduce((a, b) => a + b, 0) / segments.length * 0.85), `片段完成 ${progress.filter(p => p === 100).length}/${segments.length}`);
    const files: string[] = new Array(segments.length);
    let next = 0; let failure: unknown;
    const work = async () => {
      while (!failure && next < segments.length) {
        const i = next++; const segment = segments[i];
        try {
          await assertActive();
          if (segment.vendor_task_id === UNKNOWN) throw new MarketingRunError("SUBMISSION_UNKNOWN", UNKNOWN_SUBMISSION_MESSAGE);
          let output = segment.output;
          let generated = false;
          const child = { id: segment.task_id as string, userId: job.userId, input: { ...job.input, draft: undefined, durationSec: segment.duration_sec, generate_audio: generateAudio, reference_audio: generateAudio ? job.input.reference_audio : undefined } };
          const gen = await deps.generation(child, controller.signal);
          const meter = async (usage: Record<string, unknown>) => {
            const vendor = await deps.db.getTaskVendorId(child.id);
            if (!vendor || vendor === UNKNOWN) throw new Error("片段计量缺少生成回执");
            await gen.meter.record({ ...usage, idempotencyKey: `marketing:${child.id}:${vendor}` });
          };
          if (!output?.assetIds?.length || output?.retrySafe === true) {
            // Only a definite vendor failure may be regenerated on an explicit parent retry.
            if (output?.retrySafe === true) {
              await deps.db.pool.query("UPDATE tasks SET vendor_task_id=NULL,output=NULL WHERE id=$1 AND user_id=$2", [segment.task_id, job.userId]);
            }
            await deps.db.pool.query("UPDATE tasks SET status='running',error=NULL,error_code=NULL WHERE id=$1 AND user_id=$2 AND status<>'succeeded'", [segment.task_id, job.userId]);
            // A known vendor task is polled/downloaded without rebuilding its old prompt.
            Object.assign(child.input, { prompt: prompts[i] ?? "" });
            const provider = gen.provider;
            const baseDb = gen.db;
            output = await runGenerationJob({ ...gen,
              voiceScopeTaskId: legacyVoiceClips.has(child.id) ? child.id : job.id,
              // Reuse persisted child outputs, not a generic cache that could
              // bring back a rejected short/silent clip after an explicit retry.
              cache: { get: async () => null, set: async () => {} },
              meter: { record: meter },
              provider: {
                create: async (request) => {
                  await assertActive();
                  const claim = await deps.db.pool.query("UPDATE tasks SET vendor_task_id=$2 WHERE id=$1 AND vendor_task_id IS NULL RETURNING id", [child.id, UNKNOWN]);
                  if (!claim.rowCount) throw new MarketingRunError("SUBMISSION_UNKNOWN", "片段提交结果未知，请核实原任务。");
                  await assertActive();
                  let result;
                  try { result = await provider.create(request); }
                  catch (error) {
                    // Recorded before the claim is released: if this write fails, the clip stays unknown.
                    if (gatewayFailure(error)) {
                      await deps.db.pool.query(`INSERT INTO marketing_clip_gateway_failures(owner_id,project_id,task_id,http_status,gateway_request_id)
                        VALUES($1,$2,$3,$4,$5)`, [job.userId, String(job.input.projectId), child.id, error.httpStatus, error.gatewayRequestId ?? null]);
                    }
                    // An explicit vendor rejection or a gateway 5xx created no task. Release the
                    // claim so an explicit retry may submit after the user fixes it.
                    if (definiteRejection(error) || gatewayFailure(error)) {
                      await deps.db.pool.query("UPDATE tasks SET vendor_task_id=NULL WHERE id=$1 AND vendor_task_id=$2", [child.id, UNKNOWN]);
                      if (gatewayFailure(error)) throw new MarketingRunError("GATEWAY_FAILED", GATEWAY_FAILED_MESSAGE, { cause: error });
                      throw error;
                    }
                    throw new MarketingRunError("SUBMISSION_UNKNOWN", UNKNOWN_SUBMISSION_MESSAGE);
                  }
                  if (!result.taskId) throw new MarketingRunError("SUBMISSION_UNKNOWN", "片段提交结果未知，请核实原任务。");
                  // Persist immediately, including before another async operation can fail.
                  await deps.db.setTaskVendorId(child.id, result.taskId);
                  return result;
                },
                poll: async (id) => {
                  const result = await provider.poll(id);
                  if (result.failureUnconfirmed) throw new MarketingRunError("STATUS_UNCONFIRMED", "片段状态暂时无法确认，继续任务将查询原片段。");
                  if (result.status === "failed") await deps.db.pool.query("UPDATE tasks SET output=$2 WHERE id=$1", [child.id, JSON.stringify({ retrySafe: true })]);
                  return result;
                },
              },
              db: {
                getAsset: (id) => baseDb.getAsset(id),
                createAsset: async (a) => {
                  // Asset and recoverable output commit together, before billing.
                  const assetConnection = await deps.db.pool.connect();
                  try {
                    await assetConnection.query("BEGIN");
                    await assetConnection.query(`INSERT INTO assets(id,task_id,user_id,type,storage_key,url,mime,size_bytes,duration_sec)
                      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [a.id, child.id, job.userId, "video", a.storageKey, a.url, a.mime, a.sizeBytes, a.durationSec]);
                    await assetConnection.query("UPDATE tasks SET output=$2 WHERE id=$1 AND user_id=$3", [child.id, JSON.stringify({ assetIds: [a.id], assets: [{ url: a.url, mime: a.mime }] }), job.userId]);
                    await assetConnection.query("COMMIT");
                  } catch (error) { await assetConnection.query("ROLLBACK"); throw error; }
                  finally { assetConnection.release(); }
                },
                updateMessageGeneration: (...args) => baseDb.updateMessageGeneration(...args),
                getTaskVendorId: (id) => baseDb.getTaskVendorId(id), setTaskVendorId: (id, vendor) => baseDb.setTaskVendorId(id, vendor),
                getTaskStatus: async (id) => { await assertActive(); return baseDb.getTaskStatus(id); },
              },
              updateProgress: async (_id, value) => { progress[i] = Math.min(99, Math.max(0, value)); await report(); },
            }, child, "video");
            if (output.downloadFailed) throw new MarketingRunError("DOWNLOAD_INCOMPLETE", "片段已生成，下载未完成；重试将继续下载原片段。");
            generated = true;
          }
          // A clip kept from an earlier job of this draft was billed under that job's segment task.
          if (!generated && !output.reusedFrom) await meter({ userId: job.userId, taskId: child.id, modelId: gen.modelId, usage: { inputCount: 0, outputCount: Number(segment.duration_sec) } });
          const asset = await deps.db.getAsset(output.assetIds[0]);
          if (!asset || asset.user_id !== job.userId) throw new MarketingRunError("NOT_RECOVERABLE", "片段素材不可用");
          files[i] = await ownedAssetPath(deps.dataRoot, asset);
          const info = await inspectMedia(files[i], controller.signal);
          if (!info.video || (generateAudio && !info.audio) || info.duration < Number(segment.duration_sec) - 0.25) {
            await deps.db.pool.query("UPDATE tasks SET status='running',output=$2 WHERE id=$1 AND user_id=$3", [child.id, JSON.stringify({ retrySafe: true }), job.userId]);
            throw new MarketingRunError("QUALITY_CHECK_FAILED", "生成片段缺少配音或时长不足；继续任务会重新生成该片段。");
          }
          await assertActive();
          await deps.db.pool.query("UPDATE tasks SET status='running' WHERE id=$1 AND user_id=$2 AND status IN ('failed','cancelled')", [child.id, job.userId]);
          await deps.db.setTaskResult(child.id, output);
          progress[i] = 100; await report();
        } catch (error) {
          failure ??= error;
          if (controller.signal.aborted) await deps.db.cancelTask(segment.task_id);
          else await deps.db.setTaskError(segment.task_id, error instanceof Error ? error.message : "片段生成失败", marketingFailureCode(error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(deps.segmentConcurrency ?? 2, segments.length) }, () => work()));
    if (failure) throw failure;
    await assertActive();
    await deps.db.updateTaskProgress(job.id, 90, "正在合成视频");
    let music: string | undefined;
    if (draft.assets.music) {
      const asset = await deps.db.getAsset(draft.assets.music);
      if (!asset || asset.user_id !== job.userId) throw new MarketingRunError("NOT_RECOVERABLE", "背景音乐不可用");
      music = await ownedAssetPath(deps.dataRoot, asset).catch(() => { throw new MarketingRunError("NOT_RECOVERABLE", "背景音乐不可用"); });
    }
    // Every clip is stored by now, so a retry reassembles them without a model call.
    try {
      const result = await (deps.compose ?? composeMarketingVideo)({ files, segments: segments.map((s) => ({ index: s.slot, script: s.script, durationSec: s.duration_sec })) as MarketingSegment[], draft, music, narration, subtitles: burnSubtitles, signal: controller.signal });
      await assertActive();
      const gen = await deps.generation(job, controller.signal);
      const id = randomUUID(); const key = `${id}.mp4`;
      const { url } = await gen.storage.put({ key, body: result.body, contentType: "video/mp4" });
      await assertActive();
      await deps.db.createAsset({ id, taskId: job.id, userId: job.userId, type: "video", storageKey: key, url, mime: "video/mp4", sizeBytes: result.body.length, durationSec: result.durationSec, width: result.width, height: result.height });
      return { assetIds: [id], assets: [{ url, mime: "video/mp4", durationSec: result.durationSec }] };
    } catch (error) {
      if (error instanceof JobCancelledError || error instanceof MarketingRunError) throw error;
      throw new MarketingRunError("COMPOSITION_FAILED", error instanceof Error ? error.message : "视频合成失败", { cause: error });
    }
  } catch (error) {
    // The queue stores `errorCode` with the message; cancellation is recorded by status.
    if (error instanceof JobCancelledError || error instanceof MarketingRunError) throw error;
    throw new MarketingRunError(marketingFailureCode(error), error instanceof Error ? error.message : String(error), { cause: error });
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener("abort", abort);
    try { if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]); }
    finally { connection.release(); }
  }
}
