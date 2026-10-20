import { randomUUID } from "node:crypto";
import type pg from "pg";
import { MARKETING_VIDEO_QUEUE } from "../jobs/task-queues.js";
import { MarketingDraftSchema, marketingJobProfile, type MarketingDraft, type MarketingProject, type MarketingProjectStore, type MarketingReview, resolveMarketingSegments, marketingReviewText } from "@lot-agent/core/marketing-video";
import { UNKNOWN_SUBMISSION } from "./recovery.js";

export class MarketingError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 429 | 503 = 400) { super(message); }
}
export const reviewText = marketingReviewText;
export function renderKey(draft: MarketingDraft) {
  // PG JSONB reorders object keys. Normalize through the schema before comparing.
  const { publishTitle: _title, tags: _tags, ...rest } = MarketingDraftSchema.parse(draft);
  return JSON.stringify(rest);
}
const select = `SELECT p.*, t.status, t.progress, t.stage, t.error, t.output,
  (SELECT count(*)::int FROM marketing_video_segments s JOIN tasks st ON st.id=s.task_id
    WHERE s.project_id=p.id AND st.input->>'parentId'=p.task_id::text AND st.vendor_task_id='${UNKNOWN_SUBMISSION}') AS unknown_segments
  FROM marketing_video_projects p LEFT JOIN tasks t ON t.id=p.task_id`;
function project(row: Record<string, any>): MarketingProject {
  return { id: row.id, version: row.version, draft: MarketingDraftSchema.parse(row.draft), updatedAt: new Date(row.updated_at).toISOString(), review: row.review,
    ...(row.reference_analysis_id ? { referenceAnalysis: { id: row.reference_analysis_id, acceptedRevision: row.reference_revision, evidenceIds: row.reference_evidence_ids ?? [] } } : {}),
    reviewedScript: row.reviewed_script, taskId: row.task_id, status: row.status ?? "draft", progress: Number(row.progress ?? 0),
    stage: row.stage ?? undefined, error: row.error ?? undefined, output: row.output ?? undefined, knowledgeItemId: row.knowledge_item_id, knowledgeVersion: row.knowledge_version,
    ...(Number(row.unknown_segments) > 0 ? { unknownSegments: Number(row.unknown_segments) } : {}) };
}
export class PgMarketingProjectStore implements MarketingProjectStore {
  constructor(readonly pool: pg.Pool) {}
  async get(owner: string, id: string) {
    const { rows } = await this.pool.query(`${select} WHERE p.user_id=$1 AND p.id=$2`, [owner, id]);
    return rows[0] ? project(rows[0]) : null;
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
        if (old.task_id && renderKey(old.draft) !== renderKey(draft)) throw new MarketingError("已提交的制作配置不可修改，请复制为新草稿。", 409);
        await client.query(`UPDATE marketing_video_projects SET draft=$3,version=version+1,updated_at=now(),
          reference_analysis_id=CASE WHEN draft->>'reference'=$3::jsonb->>'reference' AND draft->'referenceUpload' IS NOT DISTINCT FROM $3::jsonb->'referenceUpload' AND draft->>'copyMode'=$3::jsonb->>'copyMode' THEN reference_analysis_id ELSE NULL END,
          reference_revision=CASE WHEN draft->>'reference'=$3::jsonb->>'reference' AND draft->'referenceUpload' IS NOT DISTINCT FROM $3::jsonb->'referenceUpload' AND draft->>'copyMode'=$3::jsonb->>'copyMode' THEN reference_revision ELSE NULL END,
          reference_evidence_ids=CASE WHEN draft->>'reference'=$3::jsonb->>'reference' AND draft->'referenceUpload' IS NOT DISTINCT FROM $3::jsonb->'referenceUpload' AND draft->>'copyMode'=$3::jsonb->>'copyMode' THEN reference_evidence_ids ELSE NULL END,
          review=CASE WHEN reviewed_script=$4 THEN review ELSE NULL END,
          reviewed_script=CASE WHEN reviewed_script=$4 THEN reviewed_script ELSE NULL END WHERE id=$1 AND user_id=$2`, [id, owner, JSON.stringify(draft), reviewText(draft)]);
      }
      // Read our own version while holding the row lock. A post-commit read
      // could acknowledge a newer tab's version as if it were this save.
      const saved = (await client.query(`${select} WHERE p.user_id=$1 AND p.id=$2`, [owner, id])).rows[0];
      await client.query("COMMIT");
      return project(saved);
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
          await client.query(`UPDATE tasks SET status='pending',error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('failed','cancelled')`, [p.task_id, owner]);
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
  /** Remove the draft record only; uploaded materials and generated videos stay in the owner's personal assets. */
  async remove(owner: string, id: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Same lock order as text operations: owner text lock, then the project row.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`marketing-text:${owner}`]);
      const p = (await client.query(`${select} WHERE p.user_id=$1 AND p.id=$2 FOR UPDATE OF p`, [owner, id])).rows[0];
      if (!p) throw new MarketingError("草稿不存在", 404);
      if (p.task_id) {
        if (["pending", "running"].includes(p.status)) throw new MarketingError("视频正在生成，请先取消，任务结束后再删除。", 409);
        const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [`marketing:${p.task_id}`]);
        if (!lock.rows[0].locked) throw new MarketingError("原任务正在收尾，请稍后再删除。", 409);
      }
      if ((await client.query("SELECT 1 FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2 AND status IN ('running','unknown','needs_apply')", [owner, id])).rowCount
        || (p.reference_analysis_id && (await client.query("SELECT 1 FROM marketing_reference_analyses WHERE id=$1 AND status IN ('queued','running')", [p.reference_analysis_id])).rowCount)) {
        throw new MarketingError("已有创作请求正在处理或结果待核实，请稍后再删除。", 409);
      }
      await client.query("DELETE FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2", [owner, id]);
      await client.query("DELETE FROM marketing_video_projects WHERE user_id=$1 AND id=$2", [owner, id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async segments(owner: string, id: string) {
    return (await this.pool.query(`SELECT s.*,t.status,t.vendor_task_id,t.output,t.error FROM marketing_video_segments s JOIN marketing_video_projects p ON p.id=s.project_id JOIN tasks t ON t.id=s.task_id
      WHERE p.id=$1 AND p.user_id=$2 AND t.user_id=p.user_id AND t.type='marketing.segment'
        AND t.input->>'parentId'=p.task_id::text ORDER BY s.slot`, [id, owner])).rows;
  }
}
