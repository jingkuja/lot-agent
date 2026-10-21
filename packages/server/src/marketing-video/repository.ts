import { randomUUID } from "node:crypto";
import type pg from "pg";
import { MARKETING_VIDEO_QUEUE } from "../jobs/task-queues.js";
import { isMarketingFailureCode, MarketingDraftSchema, marketingJobProfile, marketingRevisionKey, marketingShotChanged, storyboardScript, type MarketingDraft, type MarketingProject, type MarketingProjectStore, type MarketingTaskState, type MarketingReview, resolveMarketingSegments, marketingReviewText } from "@lot-agent/core/marketing-video";
import { segmentRecoveryAction, UNKNOWN_SUBMISSION } from "./recovery.js";
import { analysisDeleteBlocker, deleteAnalysisRecord, ownerLock as analysisOwnerLock } from "../marketing-analysis/repository.js";

export class MarketingError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 429 | 503 = 400) { super(message); }
}
export const reviewText = marketingReviewText;
export function renderKey(draft: MarketingDraft) {
  // PG JSONB reorders object keys. Normalize through the schema before comparing.
  const { publishTitle: _title, tags: _tags, ...rest } = MarketingDraftSchema.parse(draft);
  return JSON.stringify(rest);
}
const taskColumns = `t.status, t.progress, t.stage, t.error, t.error_code, t.output,
  (SELECT count(*)::int FROM marketing_video_segments s JOIN tasks st ON st.id=s.task_id
    WHERE s.project_id=p.id AND st.input->>'parentId'=p.task_id::text AND st.vendor_task_id='${UNKNOWN_SUBMISSION}') AS unknown_segments`;
const select = `SELECT p.*, ${taskColumns} FROM marketing_video_projects p LEFT JOIN tasks t ON t.id=p.task_id`;
function taskState(row: Record<string, any>): MarketingTaskState {
  return { id: row.id, version: row.version, taskId: row.task_id, status: row.status ?? "draft", progress: Number(row.progress ?? 0),
    stage: row.stage ?? undefined, error: row.error ?? undefined, ...(isMarketingFailureCode(row.error_code) ? { errorCode: row.error_code } : {}), output: row.output ?? undefined,
    ...(Number(row.unknown_segments) > 0 ? { unknownSegments: Number(row.unknown_segments) } : {}) };
}
function project(row: Record<string, any>): MarketingProject {
  return { ...taskState(row), draft: MarketingDraftSchema.parse(row.draft), updatedAt: new Date(row.updated_at).toISOString(), review: row.review,
    ...(row.reference_analysis_id ? { referenceAnalysis: { id: row.reference_analysis_id, acceptedRevision: row.reference_revision, evidenceIds: row.reference_evidence_ids ?? [] } } : {}),
    reviewedScript: row.reviewed_script, knowledgeItemId: row.knowledge_item_id, knowledgeVersion: row.knowledge_version };
}
/** The stopped or finished job of a draft whose single shots can be redone, with its clips.
 * A clip whose vendor task is still open or unknown must be settled by the job first. */
async function revisionBase(db: pg.Pool | pg.PoolClient, owner: string, id: string) {
  const { rows } = await db.query(`SELECT t.status, t.input AS job_input, s.slot, s.script, s.task_id, st.vendor_task_id, st.output
    FROM marketing_video_projects p JOIN tasks t ON t.id=p.task_id AND t.user_id=p.user_id AND t.type='marketing.video'
    JOIN marketing_video_segments s ON s.project_id=p.id
    JOIN tasks st ON st.id=s.task_id AND st.user_id=p.user_id AND st.type='marketing.segment' AND st.input->>'parentId'=p.task_id::text
    WHERE p.user_id=$1 AND p.id=$2 ORDER BY s.slot`, [owner, id]);
  const job = rows[0];
  // Version 1 inputs predate the reference rules every new clip must meet.
  if (!job || !["succeeded", "failed", "cancelled"].includes(job.status) || !(Number(job.job_input.marketingInputVersion) >= 2)) return undefined;
  const draft = MarketingDraftSchema.parse(job.job_input.draft);
  const actions = rows.map(row => segmentRecoveryAction(row));
  if (draft.storyboard.length !== rows.length || rows.some((row, i) => row.slot !== i) || actions.some(action => action === "unknown" || action === "poll")) return undefined;
  let modelId: string;
  try { modelId = marketingJobProfile(job.job_input).modelId; } catch { return undefined; }
  return { input: job.job_input as Record<string, unknown>, draft, modelId, segments: rows, reusable: actions.map(action => action === "reuse") };
}
async function withRevision(db: pg.Pool | pg.PoolClient, owner: string, p: MarketingProject): Promise<MarketingProject> {
  const base = p.taskId ? await revisionBase(db, owner, p.id) : undefined;
  return base ? { ...p, revision: { draft: base.draft, modelId: base.modelId, reusable: base.reusable } } : p;
}
export class PgMarketingProjectStore implements MarketingProjectStore {
  constructor(readonly pool: pg.Pool) {}
  async get(owner: string, id: string) {
    const { rows } = await this.pool.query(`${select} WHERE p.user_id=$1 AND p.id=$2`, [owner, id]);
    return rows[0] ? withRevision(this.pool, owner, project(rows[0])) : null;
  }
  /** One indexed row per poll: no draft parsing, material lookups or link signing. */
  async taskState(owner: string, id: string) {
    const { rows } = await this.pool.query(`SELECT p.id, p.version, p.task_id, ${taskColumns}
      FROM marketing_video_projects p LEFT JOIN tasks t ON t.id=p.task_id WHERE p.user_id=$1 AND p.id=$2`, [owner, id]);
    return rows[0] ? taskState(rows[0]) : null;
  }
  async list(owner: string) {
    return (await this.page(owner)).data;
  }
  /** Newest first. The cursor carries the exact PG timestamp text, so no row is skipped or repeated. */
  async page(owner: string, options: { limit?: number; cursor?: string; query?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);
    let after: [string, string] | undefined;
    if (options.cursor) {
      try { after = JSON.parse(Buffer.from(options.cursor, "base64url").toString()); } catch { /* checked below */ }
      if (!Array.isArray(after) || after.length !== 2 || !after.every(v => typeof v === "string") || Number.isNaN(Date.parse(after[0]))) throw new MarketingError("草稿列表参数无效。");
    }
    const query = options.query?.trim().slice(0, 100);
    const params: unknown[] = [owner];
    let where = "p.user_id=$1";
    if (after) { params.push(after[0], after[1]); where += ` AND (p.updated_at, p.id::text) < ($2::timestamptz, $3)`; }
    if (query) {
      params.push(`%${query.replace(/[\\%_]/g, c => `\\${c}`)}%`);
      const n = `$${params.length}`;
      where += ` AND (p.draft->>'topic' ILIKE ${n} OR p.draft->>'publishTitle' ILIKE ${n} OR p.draft->>'script' ILIKE ${n} OR p.draft->>'tags' ILIKE ${n})`;
    }
    params.push(limit + 1);
    const { rows } = await this.pool.query(`${select.replace("SELECT p.*,", "SELECT p.*, p.updated_at::text AS cursor_at,")} WHERE ${where}
      ORDER BY p.updated_at DESC, p.id::text DESC LIMIT $${params.length}`, params);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { data: rows.slice(0, limit).map(project), nextCursor: last ? Buffer.from(JSON.stringify([last.cursor_at, String(last.id)])).toString("base64url") : undefined };
  }
  async save(owner: string, id: string, version: number, draft: MarketingDraft) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const old = (await client.query("SELECT * FROM marketing_video_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", [id, owner])).rows[0];
      if (!old) {
        if (version !== 0) throw new MarketingError("草稿不存在", 404);
        const result = await client.query(`INSERT INTO marketing_video_projects(id,user_id,draft) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [id, owner, JSON.stringify(draft)]);
        if (!result.rowCount) throw new MarketingError("草稿保存冲突，请刷新后重试。", 409);
      } else {
        if (version !== old.version) throw new MarketingError("草稿已在其他页面更新，请重新打开。", 409);
        if (old.task_id && renderKey(old.draft) !== renderKey(draft)) {
          // A stopped or finished video may change shot text to redo those shots; all else stays frozen.
          const base = await revisionBase(client, owner, id);
          if (!base) throw new MarketingError("已提交的制作配置不可修改，请复制为新草稿。", 409);
          if (renderKey(base.draft) !== renderKey(draft)
            && (marketingRevisionKey(base.draft) !== marketingRevisionKey(draft) || storyboardScript(draft.storyboard) !== draft.script.trim())) {
            throw new MarketingError("成片只能修改分镜的口播、画面、动作和镜头，其他制作配置不可修改，请复制为新草稿。", 409);
          }
        }
        await client.query(`UPDATE marketing_video_projects SET draft=$3,version=version+1,updated_at=now(),
          reference_analysis_id=CASE WHEN draft->>'reference'=$3::jsonb->>'reference' AND draft->'referenceUpload' IS NOT DISTINCT FROM $3::jsonb->'referenceUpload' AND draft->>'copyMode'=$3::jsonb->>'copyMode' THEN reference_analysis_id ELSE NULL END,
          reference_revision=CASE WHEN draft->>'reference'=$3::jsonb->>'reference' AND draft->'referenceUpload' IS NOT DISTINCT FROM $3::jsonb->'referenceUpload' AND draft->>'copyMode'=$3::jsonb->>'copyMode' THEN reference_revision ELSE NULL END,
          reference_evidence_ids=CASE WHEN draft->>'reference'=$3::jsonb->>'reference' AND draft->'referenceUpload' IS NOT DISTINCT FROM $3::jsonb->'referenceUpload' AND draft->>'copyMode'=$3::jsonb->>'copyMode' THEN reference_evidence_ids ELSE NULL END,
          review=CASE WHEN reviewed_script=$4 THEN review ELSE NULL END,
          reviewed_script=CASE WHEN reviewed_script=$4 THEN reviewed_script ELSE NULL END WHERE id=$1 AND user_id=$2`, [id, owner, JSON.stringify(draft), reviewText(draft)]);
      }
      // Read our own version while holding the row lock. A post-commit read
      // could acknowledge a newer tab's version as if it were this save.
      const saved = await withRevision(client, owner, project((await client.query(`${select} WHERE p.user_id=$1 AND p.id=$2`, [owner, id])).rows[0]));
      await client.query("COMMIT");
      return saved;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async setReview(owner: string, p: MarketingProject, review: MarketingReview) {
    const result = await this.pool.query(`UPDATE marketing_video_projects SET review=$4,reviewed_script=$5 WHERE user_id=$1 AND id=$2 AND version=$3`,
      [owner, p.id, p.version, JSON.stringify(review), reviewText(p.draft)]);
    if (!result.rowCount) throw new MarketingError("文案已更新，请重新检查。", 409);
    return (await this.get(owner, p.id))!;
  }
  /** Commit parent and all segment intents together; Redis delivery can safely be retried. */
  async reserve(owner: string, id: string, version: number, input: Record<string, unknown>, retry: boolean) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const p = (await client.query(`SELECT * FROM marketing_video_projects WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, owner])).rows[0];
      if (!p) throw new MarketingError("草稿不存在", 404);
      if (p.version !== version) throw new MarketingError("草稿已更新，请重新确认。", 409);
      if (p.task_id) {
        if (retry) {
          const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [`marketing:${p.task_id}`]);
          if (!lock.rows[0].locked) throw new MarketingError("原任务正在收尾，请稍后继续。", 409);
          await client.query(`UPDATE tasks SET status='pending',error=NULL,error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('failed','cancelled')`, [p.task_id, owner]);
        }
        await client.query("COMMIT"); return p.task_id as string;
      }
      if (!p.review || p.reviewed_script !== reviewText(p.draft) || p.review.verdict === "reject") throw new MarketingError("请先完成当前文案检查。");
      // Validate the complete duration plan before creating any video task.
      const plan = resolveMarketingSegments(MarketingDraftSchema.parse(p.draft), marketingJobProfile(input));
      const taskId = randomUUID();
      await client.query(`INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,'marketing.video',$2,$3,$4)`, [taskId, JSON.stringify({ ...input, projectId: id, draft: p.draft,
        ...(p.reference_analysis_id ? { referenceAnalysis: { id: p.reference_analysis_id, acceptedRevision: p.reference_revision, evidenceIds: p.reference_evidence_ids } } : {}) }), owner, MARKETING_VIDEO_QUEUE]);
      for (const part of plan) {
        const childId = randomUUID();
        // These tasks are executed by the parent, never delivered independently.
        await client.query(`INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,'marketing.segment',$2,$3,'marketing-segments')`, [childId, JSON.stringify({ parentId: taskId, ...part }), owner]);
        await client.query(`INSERT INTO marketing_video_segments(project_id,slot,task_id,script,duration_sec) VALUES($1,$2,$3,$4,$5)`, [id, part.index, childId, part.script, part.durationSec]);
      }
      await client.query(`UPDATE marketing_video_projects SET task_id=$3,updated_at=now() WHERE id=$1 AND user_id=$2`, [id, owner, taskId]);
      await client.query("COMMIT"); return taskId;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  /** Redo the chosen shots of a stopped or finished video as a new job of the same draft.
   * Every other shot keeps its clip: its new segment task is already succeeded and points
   * at the existing asset, so it is neither submitted nor billed again. */
  async revise(owner: string, id: string, version: number, baseTaskId: string, redo: number[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const p = (await client.query(`SELECT * FROM marketing_video_projects WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, owner])).rows[0];
      if (!p) throw new MarketingError("草稿不存在", 404);
      if (p.version !== version || p.task_id !== baseTaskId) throw new MarketingError("草稿已更新，请重新确认。", 409);
      // Same key as the worker's job lock: never race a worker that is still finishing.
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [`marketing:${baseTaskId}`]);
      if (!lock.rows[0].locked) throw new MarketingError("原任务正在收尾，请稍后继续。", 409);
      if (!p.review || p.reviewed_script !== reviewText(p.draft) || p.review.verdict === "reject") throw new MarketingError("请先完成当前文案检查。");
      const base = await revisionBase(client, owner, id);
      const draft = MarketingDraftSchema.parse(p.draft);
      if (!base || marketingRevisionKey(base.draft) !== marketingRevisionKey(draft)) throw new MarketingError("当前视频不能单镜重做，请复制为新草稿。", 409);
      const plan = resolveMarketingSegments(draft, marketingJobProfile(base.input));
      // The caller confirmed the billed shots: a changed shot or a missing clip is never added silently.
      const required = plan.filter(part => !base.reusable[part.index] || part.script !== base.segments[part.index].script
        || marketingShotChanged(base.draft.storyboard[part.index], draft.storyboard[part.index])).map(part => part.index);
      if (!redo.length || redo.some(slot => !plan[slot]) || required.some(slot => !redo.includes(slot))) throw new MarketingError("请重新选择需要重新生成的镜头。", 409);
      const taskId = randomUUID();
      await client.query(`INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,'marketing.video',$2,$3,$4)`,
        [taskId, JSON.stringify({ ...base.input, draft: p.draft, revisedFrom: baseTaskId }), owner, MARKETING_VIDEO_QUEUE]);
      for (const part of plan) {
        const childId = randomUUID(); const old = base.segments[part.index];
        const input = JSON.stringify({ parentId: taskId, ...part });
        if (redo.includes(part.index)) {
          await client.query(`INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,'marketing.segment',$2,$3,'marketing-segments')`, [childId, input, owner]);
        } else {
          // reusedFrom names the task that owns the asset, also across repeated redos.
          const output = { assetIds: old.output.assetIds, assets: old.output.assets ?? [], reusedFrom: old.output.reusedFrom ?? old.task_id };
          await client.query(`INSERT INTO tasks(id,type,input,user_id,queue_name,status,progress,output) VALUES($1,'marketing.segment',$2,$3,'marketing-segments','succeeded',100,$4)`,
            [childId, input, owner, JSON.stringify(output)]);
        }
        await client.query(`INSERT INTO marketing_video_segments(project_id,slot,task_id,script,duration_sec) VALUES($1,$2,$3,$4,$5)`, [id, part.index, childId, part.script, part.durationSec]);
      }
      await client.query(`UPDATE marketing_video_projects SET task_id=$3,updated_at=now() WHERE id=$1 AND user_id=$2`, [id, owner, taskId]);
      await client.query("COMMIT"); return taskId;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  /** The user accepts a possible duplicate charge for clips whose submission outcome is
   * unknown. Only those clips become new submissions; finished and known vendor clips are
   * kept. Each release is counted on the segment for billing reconciliation. */
  async releaseUnknownSegments(owner: string, id: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const p = (await client.query(`SELECT p.task_id,t.status FROM marketing_video_projects p JOIN tasks t ON t.id=p.task_id
        WHERE p.id=$1 AND p.user_id=$2 AND t.user_id=p.user_id FOR UPDATE OF p`, [id, owner])).rows[0];
      if (!p) throw new MarketingError("草稿不存在", 404);
      if (!["failed", "cancelled"].includes(p.status)) throw new MarketingError("视频正在生成，请等任务停止后再处理。", 409);
      // Same key as the worker's job lock: never race a worker that is still finishing.
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [`marketing:${p.task_id}`]);
      if (!lock.rows[0].locked) throw new MarketingError("原任务正在收尾，请稍后继续。", 409);
      const released = (await client.query(`UPDATE tasks st SET vendor_task_id=NULL,output='{"retrySafe":true}'::jsonb,updated_at=now()
        FROM marketing_video_segments s WHERE s.project_id=$1 AND st.id=s.task_id AND st.user_id=$2 AND st.type='marketing.segment'
          AND st.input->>'parentId'=$3 AND st.vendor_task_id=$4 RETURNING st.id`, [id, owner, p.task_id, UNKNOWN_SUBMISSION])).rows.map(row => row.id as string);
      if (!released.length) throw new MarketingError("没有结果未知的片段。", 409);
      await client.query(`UPDATE marketing_video_segments SET unknown_released_count=unknown_released_count+1,unknown_released_at=now()
        WHERE project_id=$1 AND task_id=ANY($2::uuid[])`, [id, released]);
      await client.query("COMMIT");
      console.warn("[marketing-video] unknown segments released", { projectId: id, taskId: p.task_id, segments: released.length });
      return released.length;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  /** Remove the draft with its generated clips and final video, and the reference
   * analyses made for it. Asset rows go in this transaction; the caller removes their
   * files after commit. Uploaded materials stay in the owner's personal assets. */
  async remove(owner: string, id: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Same lock order as text operations: owner text lock, then the project row.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`marketing-text:${owner}`]);
      // Same lock order as analysis jobs: owner analysis lock, analysis rows, project row.
      await analysisOwnerLock(client, owner);
      const analyses = (await client.query(`SELECT a.* FROM marketing_reference_analyses a WHERE a.user_id=$1 AND a.deleted_at IS NULL
        AND (a.creation_context->>'projectId'=$2 OR a.id=(SELECT reference_analysis_id FROM marketing_video_projects WHERE user_id=$1 AND id=$2::uuid))
        FOR UPDATE OF a`, [owner, id])).rows;
      const p = (await client.query(`${select} WHERE p.user_id=$1 AND p.id=$2 FOR UPDATE OF p`, [owner, id])).rows[0];
      if (!p) throw new MarketingError("草稿不存在", 404);
      if (p.task_id) {
        if (["pending", "running"].includes(p.status)) throw new MarketingError("视频正在生成，请先取消，任务结束后再删除。", 409);
        const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [`marketing:${p.task_id}`]);
        if (!lock.rows[0].locked) throw new MarketingError("原任务正在收尾，请稍后再删除。", 409);
      }
      const blockers = [];
      for (const row of analyses) blockers.push(await analysisDeleteBlocker(client, row));
      if ((await client.query("SELECT 1 FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2 AND status IN ('running','unknown','needs_apply')", [owner, id])).rowCount
        || blockers.includes("ANALYSIS_BUSY")) {
        throw new MarketingError("已有创作请求正在处理或结果待核实，请稍后再删除。", 409);
      }
      // Earlier jobs of redone shots are reached through their segment rows.
      const files = p.task_id ? (await client.query(`DELETE FROM assets WHERE user_id=$1 AND type='video'
        AND task_id IN (SELECT $2::uuid UNION SELECT task_id FROM marketing_video_segments WHERE project_id=$3
          UNION SELECT (st.input->>'parentId')::uuid FROM marketing_video_segments s JOIN tasks st ON st.id=s.task_id WHERE s.project_id=$3)
        RETURNING storage_key, size_bytes`, [owner, p.task_id, id])).rows : [];
      await client.query("DELETE FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2", [owner, id]);
      await client.query("DELETE FROM marketing_video_projects WHERE user_id=$1 AND id=$2", [owner, id]);
      const removedAnalyses: string[] = []; let keptAnalyses = 0;
      for (const [i, row] of analyses.entries()) {
        // An unknown model request keeps its record for reconciliation; another draft may still use the analysis.
        if (blockers[i] || (await client.query("SELECT 1 FROM marketing_video_projects WHERE reference_analysis_id=$1", [row.id])).rowCount) { keptAnalyses++; continue; }
        await deleteAnalysisRecord(client, row);
        removedAnalyses.push(row.id);
      }
      await client.query("COMMIT");
      return { files: files.map(row => row.storage_key as string), removedBytes: files.reduce((sum, row) => sum + Number(row.size_bytes), 0), removedAnalyses, keptAnalyses };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  /** Space held by the owner's drafts: generated clips and final videos, and the uploads they use. */
  async usage(owner: string) {
    const { rows } = await this.pool.query(`WITH jobs AS (
        SELECT task_id AS id FROM marketing_video_projects WHERE user_id=$1 AND task_id IS NOT NULL
        UNION SELECT s.task_id FROM marketing_video_segments s JOIN marketing_video_projects p ON p.id=s.project_id WHERE p.user_id=$1
        UNION SELECT (st.input->>'parentId')::uuid FROM marketing_video_segments s JOIN marketing_video_projects p ON p.id=s.project_id
          JOIN tasks st ON st.id=s.task_id WHERE p.user_id=$1)
      SELECT (SELECT COALESCE(SUM(size_bytes),0) FROM assets WHERE user_id=$1 AND type='video' AND task_id IN (SELECT id FROM jobs)) AS video_bytes,
        (SELECT COALESCE(SUM(size_bytes),0) FROM assets WHERE user_id=$1 AND type='upload' AND id::text IN (
          SELECT jsonb_array_elements_text(CASE jsonb_typeof(e.value) WHEN 'array' THEN e.value ELSE jsonb_build_array(e.value) END)
          FROM marketing_video_projects p, jsonb_each(COALESCE(p.draft->'assets','{}'::jsonb)) e WHERE p.user_id=$1)) AS material_bytes`, [owner]);
    return { videoBytes: Number(rows[0].video_bytes), materialBytes: Number(rows[0].material_bytes) };
  }
  async segments(owner: string, id: string) {
    return (await this.pool.query(`SELECT s.*,t.status,t.vendor_task_id,t.output,t.error FROM marketing_video_segments s JOIN marketing_video_projects p ON p.id=s.project_id JOIN tasks t ON t.id=s.task_id
      WHERE p.id=$1 AND p.user_id=$2 AND t.user_id=p.user_id AND t.type='marketing.segment'
        AND t.input->>'parentId'=p.task_id::text ORDER BY s.slot`, [id, owner])).rows;
  }
}
