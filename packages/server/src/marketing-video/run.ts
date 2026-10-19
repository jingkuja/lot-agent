import { randomUUID } from "node:crypto";
import { ProviderError } from "@lot-agent/core";
import { marketingJobProfile, marketingReferenceError, marketingShotMaxSeconds, MarketingDraftSchema, resolveMarketingSegments, isMarketingDurationValid, type MarketingSegment } from "@lot-agent/core/marketing-video";
import type { DB } from "../db/database.js";
import { JobCancelledError, runGenerationJob, type RunJobDeps } from "../generation/run-job.js";
import { PgMarketingProjectStore } from "./repository.js";
import { composeMarketingVideo, inspectMedia, ownedAssetPath } from "./media.js";
import { marketingSegmentPrompt } from "./prompt.js";
import { segmentRecoveryAction, UNKNOWN_SUBMISSION, UNKNOWN_SUBMISSION_MESSAGE } from "./recovery.js";

const UNKNOWN = UNKNOWN_SUBMISSION;
// 4xx answers reject the request itself; 408/409 and 5xx may still have created a task.
// CONNECT_ERROR means the POST was never written, so no vendor task can exist.
const REJECTED_STATUS = new Set([400, 401, 402, 403, 404, 413, 422, 429]);
export function definiteRejection(error: unknown) {
  return error instanceof ProviderError && error.phase === "create"
    && (error.code === "REAL_PERSON_REJECTED" || error.code === "CONNECT_ERROR" || (error.code === "HTTP_ERROR" && REJECTED_STATUS.has(error.httpStatus ?? 0)));
}
export interface MarketingRunDeps {
  db: DB; dataRoot: string;
  generation(job: { userId: string; input: Record<string, unknown> }, signal: AbortSignal): Promise<RunJobDeps>;
  compose?: typeof composeMarketingVideo;
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
    if (!locked) throw new Error("该视频正在处理，请稍后查询原任务。");
    const store = new PgMarketingProjectStore(deps.db.pool);
    const project = await store.get(job.userId, String(job.input.projectId));
    if (!project || project.taskId !== job.id) throw new Error("视频任务不存在");
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
    const inputVersion = typeof job.input.marketingInputVersion === "number" ? job.input.marketingInputVersion : 1;
    // The frozen model's rules apply; version 1 inputs predate reference checks.
    const profile = marketingJobProfile(job.input);
    const referenceError = inputVersion >= 2 ? marketingReferenceError(draft, profile) : "";
    if (referenceError) throw new Error(referenceError);
    const segments = (await store.segments(job.userId, project.id)).map(segment => ({ ...segment, duration_sec: Number(segment.duration_sec) }));
    // Stop the entire mixed batch before any fresh paid intent if a sibling's
    // submission result is still unknown.
    if (segments.some(segment => segmentRecoveryAction(segment) === "unknown")) throw new Error(UNKNOWN_SUBMISSION_MESSAGE);
    // Persisted boundaries are authoritative, including legacy jobs without a
    // storyboard. Never re-plan an already submitted video during recovery.
    // Check the full paid duration before resolving providers or sending a clip.
    if (!segments.length || segments.length > 15 || segments.some((s, i) => s.slot !== i || !Number.isInteger(s.duration_sec) || s.duration_sec < 4 || s.duration_sec > marketingShotMaxSeconds(draft, profile))
      || !isMarketingDurationValid(draft.durationSec, segments.reduce((sum, s) => sum + s.duration_sec, 0))) throw new Error("视频分段配置不完整");
    if (draft.storyboard.length) {
      const planned = resolveMarketingSegments(draft, profile);
      if (planned.length !== segments.length || planned.some((p, i) => p.script !== segments[i].script || p.durationSec !== segments[i].duration_sec)) throw new Error("视频分段配置不完整");
    } else if (segments.map(s => s.script).join("").trim() !== draft.script.trim()) throw new Error("视频分段配置不完整");
    // Validate every remaining submission before any segment incurs a model or voice charge.
    // Completed/resumable vendor tasks keep using their original submitted prompts.
    const prompts = segments.map((segment, index) => segmentRecoveryAction(segment) === "submit"
      ? marketingSegmentPrompt(draft, { index, script: segment.script, durationSec: segment.duration_sec }, segments.length, generateAudio, profile) : undefined);
    const progress: number[] = segments.map((s) => s.status === "succeeded" ? 100 : 0);
    const report = async () => deps.db.updateTaskProgress(job.id, Math.floor(progress.reduce((a, b) => a + b, 0) / segments.length * 0.85), `片段完成 ${progress.filter(p => p === 100).length}/${segments.length}`);
    const files: string[] = new Array(segments.length);
    let next = 0; let failure: unknown;
    const work = async () => {
      while (!failure && next < segments.length) {
        const i = next++; const segment = segments[i];
        try {
          await assertActive();
          if (segment.vendor_task_id === UNKNOWN) throw new Error("片段提交结果未知，请核实原任务；系统不会重复提交付费请求。");
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
            await deps.db.pool.query("UPDATE tasks SET status='running',error=NULL WHERE id=$1 AND user_id=$2 AND status<>'succeeded'", [segment.task_id, job.userId]);
            // A known vendor task is polled/downloaded without rebuilding its old prompt.
            Object.assign(child.input, { prompt: prompts[i] ?? "" });
            const provider = gen.provider;
            const baseDb = gen.db;
            output = await runGenerationJob({ ...gen,
              // Reuse persisted child outputs, not a generic cache that could
              // bring back a rejected short/silent clip after an explicit retry.
              cache: { get: async () => null, set: async () => {} },
              meter: { record: meter },
              provider: {
                create: async (request) => {
                  await assertActive();
                  const claim = await deps.db.pool.query("UPDATE tasks SET vendor_task_id=$2 WHERE id=$1 AND vendor_task_id IS NULL RETURNING id", [child.id, UNKNOWN]);
                  if (!claim.rowCount) throw new Error("片段提交结果未知，请核实原任务。");
                  await assertActive();
                  let result;
                  try { result = await provider.create(request); }
                  catch (error) {
                    // An explicit vendor rejection created no task. Release the
                    // claim so an explicit retry may submit after the user fixes it.
                    if (definiteRejection(error)) {
                      await deps.db.pool.query("UPDATE tasks SET vendor_task_id=NULL WHERE id=$1 AND vendor_task_id=$2", [child.id, UNKNOWN]);
                      throw error;
                    }
                    throw new Error(UNKNOWN_SUBMISSION_MESSAGE);
                  }
                  if (!result.taskId) throw new Error("片段提交结果未知，请核实原任务。");
                  // Persist immediately, including before another async operation can fail.
                  await deps.db.setTaskVendorId(child.id, result.taskId);
                  return result;
                },
                poll: async (id) => {
                  const result = await provider.poll(id);
                  if (result.failureUnconfirmed) throw new Error("片段状态暂时无法确认，继续任务将查询原片段。");
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
            if (output.downloadFailed) throw new Error("片段已生成，下载未完成；重试将继续下载原片段。");
            generated = true;
          }
          if (!generated) await meter({ userId: job.userId, taskId: child.id, modelId: gen.modelId, usage: { inputCount: 0, outputCount: Number(segment.duration_sec) } });
          const asset = await deps.db.getAsset(output.assetIds[0]);
          if (!asset || asset.user_id !== job.userId) throw new Error("片段素材不可用");
          files[i] = await ownedAssetPath(deps.dataRoot, asset);
          const info = await inspectMedia(files[i], controller.signal);
          if (!info.video || (generateAudio && !info.audio) || info.duration < Number(segment.duration_sec) - 0.25) {
            await deps.db.pool.query("UPDATE tasks SET status='running',output=$2 WHERE id=$1 AND user_id=$3", [child.id, JSON.stringify({ retrySafe: true }), job.userId]);
            throw new Error("生成片段缺少配音或时长不足；继续任务会重新生成该片段。");
          }
          await assertActive();
          await deps.db.pool.query("UPDATE tasks SET status='running' WHERE id=$1 AND user_id=$2 AND status IN ('failed','cancelled')", [child.id, job.userId]);
          await deps.db.setTaskResult(child.id, output);
          progress[i] = 100; await report();
        } catch (error) {
          failure ??= error;
          if (controller.signal.aborted) await deps.db.cancelTask(segment.task_id);
          else await deps.db.setTaskError(segment.task_id, error instanceof Error ? error.message : "片段生成失败");
        }
      }
    };
    await Promise.all([work(), work()]);
    if (failure) throw failure;
    await assertActive();
    await deps.db.updateTaskProgress(job.id, 90, "正在合成视频");
    let music: string | undefined;
    if (draft.assets.music) {
      const asset = await deps.db.getAsset(draft.assets.music);
      if (!asset || asset.user_id !== job.userId) throw new Error("背景音乐不可用");
      music = await ownedAssetPath(deps.dataRoot, asset);
    }
    const result = await (deps.compose ?? composeMarketingVideo)({ files, segments: segments.map((s) => ({ index: s.slot, script: s.script, durationSec: s.duration_sec })) as MarketingSegment[], draft, music, signal: controller.signal });
    await assertActive();
    const gen = await deps.generation(job, controller.signal);
    const id = randomUUID(); const key = `${id}.mp4`;
    const { url } = await gen.storage.put({ key, body: result.body, contentType: "video/mp4" });
    await assertActive();
    await deps.db.createAsset({ id, taskId: job.id, userId: job.userId, type: "video", storageKey: key, url, mime: "video/mp4", sizeBytes: result.body.length, durationSec: result.durationSec, width: result.width, height: result.height });
    return { assetIds: [id], assets: [{ url, mime: "video/mp4", durationSec: result.durationSec }] };
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener("abort", abort);
    try { if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]); }
    finally { connection.release(); }
  }
}
