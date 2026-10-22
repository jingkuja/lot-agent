import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { MarketingCaptions } from "@lot-agent/core/marketing-video";
import { PresenterDraftSchema, type PresenterDraft, type PresenterProject, type PresenterReview, type PresenterTaskState } from "@lot-agent/core/digital-presenter";
import { DIGITAL_PRESENTER_TASK, MARKETING_VIDEO_QUEUE } from "../jobs/task-queues.js";
import { isPresenterFailureCode, PresenterError } from "./errors.js";

export const presenterLockKey = (taskId: string) => `digital-presenter:${taskId}`;
const taskColumns = `t.status, t.progress, t.stage, t.error, t.error_code, t.output,
  (SELECT count(*)::int FROM digital_presenter_clips c WHERE c.task_id=p.task_id AND c.status='submitting') AS unknown_clips`;
const select = `SELECT p.*, ${taskColumns} FROM digital_presenter_projects p LEFT JOIN tasks t ON t.id=p.task_id`;

function taskState(row: Record<string, any>): PresenterTaskState {
  // A worker that stopped mid-submission leaves the clip `submitting`; only a stopped job shows it.
  const stopped = !["pending", "running"].includes(row.status);
  return { id: row.id, version: row.version, ...(row.task_id ? { taskId: row.task_id } : {}), status: row.status ?? "draft", progress: Number(row.progress ?? 0),
    ...(row.stage ? { stage: row.stage } : {}), ...(row.error ? { error: row.error } : {}), ...(isPresenterFailureCode(row.error_code) ? { errorCode: row.error_code } : {}),
    ...(row.output ? { output: row.output } : {}), ...(stopped && Number(row.unknown_clips) > 0 ? { unknownClips: Number(row.unknown_clips) } : {}) };
}
function project(row: Record<string, any>): PresenterProject {
  return { ...taskState(row), draft: PresenterDraftSchema.parse(row.draft), updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.review && row.reviewed_script === row.draft?.script ? { review: row.review as PresenterReview, reviewedScript: row.reviewed_script } : {}) };
}
const inTransaction = async <T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
};

export interface ClipRow { task_id: string; slot: number; model: string; status: "pending" | "submitting" | "running" | "succeeded" | "failed"; vendor_task_id: string | null; file: string | null; seconds: string | null; error: string | null }

export class PgPresenterStore {
  constructor(readonly pool: pg.Pool) {}
  async get(owner: string, id: string) {
    const { rows } = await this.pool.query(`${select} WHERE p.user_id=$1 AND p.id=$2`, [owner, id]);
    return rows[0] ? project(rows[0]) : null;
  }
  /** One indexed row per poll. */
  async taskState(owner: string, id: string) {
    const { rows } = await this.pool.query(`SELECT p.id, p.version, p.task_id, ${taskColumns}
      FROM digital_presenter_projects p LEFT JOIN tasks t ON t.id=p.task_id WHERE p.user_id=$1 AND p.id=$2`, [owner, id]);
    return rows[0] ? taskState(rows[0]) : null;
  }
  /** Newest first. The cursor carries the exact PG timestamp text, so no row is skipped or repeated. */
  async page(owner: string, options: { limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);
    let after: [string, string] | undefined;
    if (options.cursor) {
      try { after = JSON.parse(Buffer.from(options.cursor, "base64url").toString()); } catch { /* checked below */ }
      if (!Array.isArray(after) || after.length !== 2 || !after.every(v => typeof v === "string") || Number.isNaN(Date.parse(after[0]))) throw new PresenterError("草稿列表参数无效。");
    }
    const params: unknown[] = [owner];
    let where = "p.user_id=$1";
    if (after) { params.push(after[0], after[1]); where += ` AND (p.updated_at, p.id::text) < ($2::timestamptz, $3)`; }
    params.push(limit + 1);
    const { rows } = await this.pool.query(`${select.replace("SELECT p.*,", "SELECT p.*, p.updated_at::text AS cursor_at,")} WHERE ${where}
      ORDER BY p.updated_at DESC, p.id::text DESC LIMIT $${params.length}`, params);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { data: rows.slice(0, limit).map(project), nextCursor: last ? Buffer.from(JSON.stringify([last.cursor_at, String(last.id)])).toString("base64url") : undefined };
  }
  /** Version-checked save. A draft with a job is frozen; it is copied to change it. */
  async save(owner: string, id: string, version: number, draft: PresenterDraft) {
    return inTransaction(this.pool, async client => {
      const old = (await client.query("SELECT * FROM digital_presenter_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", [id, owner])).rows[0];
      if (!old) {
        if (version !== 0) throw new PresenterError("草稿不存在", 404);
        const result = await client.query(`INSERT INTO digital_presenter_projects(id,user_id,draft) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [id, owner, JSON.stringify(draft)]);
        if (!result.rowCount) throw new PresenterError("草稿保存冲突，请刷新后重试。", 409);
      } else {
        if (version !== old.version) throw new PresenterError("草稿已在其他页面更新，请重新打开。", 409);
        if (old.task_id) throw new PresenterError("已提交生成的草稿不可修改，请复制为新草稿。", 409);
        await client.query(`UPDATE digital_presenter_projects SET draft=$3,version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2`, [id, owner, JSON.stringify(draft)]);
      }
      return project((await client.query(`${select} WHERE p.user_id=$1 AND p.id=$2`, [owner, id])).rows[0]);
    });
  }
  async setReview(owner: string, id: string, version: number, script: string, review: PresenterReview) {
    const result = await this.pool.query(`UPDATE digital_presenter_projects SET review=$4,reviewed_script=$5 WHERE user_id=$1 AND id=$2 AND version=$3 AND draft->>'script'=$5`,
      [owner, id, version, JSON.stringify(review), script]);
    if (!result.rowCount) throw new PresenterError("文案已更新，请重新检查。", 409);
    return (await this.get(owner, id))!;
  }
  /** Commit the job and all clip intents together; Redis delivery can safely be retried. */
  async reserve(owner: string, id: string, version: number, input: Record<string, unknown>, clips: { slot: number; model: string }[]) {
    return inTransaction(this.pool, async client => {
      const p = (await client.query(`SELECT * FROM digital_presenter_projects WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, owner])).rows[0];
      if (!p) throw new PresenterError("草稿不存在", 404);
      if (p.version !== version) throw new PresenterError("草稿已更新，请重新确认。", 409);
      if (p.task_id) return p.task_id as string;
      if (!p.review || p.reviewed_script !== p.draft.script || p.review.verdict === "reject") throw new PresenterError("请先完成当前文案检查。");
      const taskId = randomUUID();
      await client.query(`INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,$2,$3,$4,$5)`,
        [taskId, DIGITAL_PRESENTER_TASK, JSON.stringify({ ...input, projectId: id, draft: p.draft }), owner, MARKETING_VIDEO_QUEUE]);
      for (const clip of clips) await client.query(`INSERT INTO digital_presenter_clips(task_id,slot,model) VALUES($1,$2,$3)`, [taskId, clip.slot, clip.model]);
      await client.query(`UPDATE digital_presenter_projects SET task_id=$3,updated_at=now() WHERE id=$1 AND user_id=$2`, [id, owner, taskId]);
      return taskId;
    });
  }
  /** A finished video composed again with changed captions. The new job reuses every clip of the
   * finished one, so no model is called; the draft keeps the captions the new job burns. */
  async recompose(owner: string, id: string, version: number, baseTaskId: string, input: Record<string, unknown>, captions: MarketingCaptions | undefined) {
    return inTransaction(this.pool, async client => {
      const p = (await client.query(`SELECT p.*,t.status FROM digital_presenter_projects p JOIN tasks t ON t.id=p.task_id AND t.user_id=p.user_id
        WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE OF p`, [id, owner])).rows[0];
      if (!p) throw new PresenterError("草稿不存在", 404);
      if (p.version !== version || p.task_id !== baseTaskId) throw new PresenterError("草稿已更新，请重新打开。", 409);
      if (p.status !== "succeeded") throw new PresenterError("视频生成完成后才能调整字幕。", 409);
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [presenterLockKey(baseTaskId)]);
      if (!lock.rows[0].locked) throw new PresenterError("原任务正在收尾，请稍后再试。", 409);
      const { captions: _old, ...rest } = PresenterDraftSchema.parse(p.draft);
      const draft: PresenterDraft = { ...rest, ...(captions ? { captions } : {}) };
      const taskId = randomUUID();
      await client.query(`INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,$2,$3,$4,$5)`,
        [taskId, DIGITAL_PRESENTER_TASK, JSON.stringify({ ...input, projectId: id, draft, recomposedFrom: baseTaskId }), owner, MARKETING_VIDEO_QUEUE]);
      const copied = await client.query(`INSERT INTO digital_presenter_clips(task_id,slot,model,status,vendor_task_id,file,seconds)
        SELECT $1,slot,model,status,vendor_task_id,file,seconds FROM digital_presenter_clips WHERE task_id=$2 AND status='succeeded'`, [taskId, baseTaskId]);
      const total = (await client.query("SELECT count(*)::int AS n FROM digital_presenter_clips WHERE task_id=$1", [baseTaskId])).rows[0].n;
      if (!copied.rowCount || copied.rowCount !== total) throw new PresenterError("原视频的片段不完整，请复制为新草稿重新生成。", 409);
      await client.query(`UPDATE digital_presenter_projects SET task_id=$3,draft=$4,version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2`, [id, owner, taskId, JSON.stringify(draft)]);
      return taskId;
    });
  }
  /** Continue a stopped job: finished clips are kept and known vendor tasks are polled again. */
  async resume(owner: string, id: string) {
    return inTransaction(this.pool, async client => {
      const p = (await client.query(`SELECT p.task_id,t.status FROM digital_presenter_projects p JOIN tasks t ON t.id=p.task_id AND t.user_id=p.user_id
        WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE OF p`, [id, owner])).rows[0];
      if (!p) throw new PresenterError("没有可继续的任务。", 409);
      if (!["failed", "cancelled"].includes(p.status)) return p.task_id as string;
      // Same key as the worker's job lock: never race a worker that is still finishing.
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [presenterLockKey(p.task_id)]);
      if (!lock.rows[0].locked) throw new PresenterError("原任务正在收尾，请稍后继续。", 409);
      if ((await client.query("SELECT 1 FROM digital_presenter_clips WHERE task_id=$1 AND status='submitting'", [p.task_id])).rowCount) {
        throw new PresenterError("有片段已提交但结果未知，请先确认是否重新提交这些片段。", 409);
      }
      await client.query(`UPDATE tasks SET status='pending',error=NULL,error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('failed','cancelled')`, [p.task_id, owner]);
      return p.task_id as string;
    });
  }
  /** The user accepts a possible duplicate charge for clips whose submission outcome is unknown.
   * Each release is counted on the clip for billing reconciliation. */
  async releaseUnknownClips(owner: string, id: string) {
    return inTransaction(this.pool, async client => {
      const p = (await client.query(`SELECT p.task_id,t.status FROM digital_presenter_projects p JOIN tasks t ON t.id=p.task_id AND t.user_id=p.user_id
        WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE OF p`, [id, owner])).rows[0];
      if (!p) throw new PresenterError("草稿不存在", 404);
      if (!["failed", "cancelled"].includes(p.status)) throw new PresenterError("视频正在生成，请等任务停止后再处理。", 409);
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [presenterLockKey(p.task_id)]);
      if (!lock.rows[0].locked) throw new PresenterError("原任务正在收尾，请稍后继续。", 409);
      const released = await client.query(`UPDATE digital_presenter_clips SET status='failed',vendor_task_id=NULL,error=NULL,released_count=released_count+1,updated_at=now()
        WHERE task_id=$1 AND status='submitting' RETURNING slot`, [p.task_id]);
      if (!released.rowCount) throw new PresenterError("没有结果未知的片段。", 409);
      console.warn("[digital-presenter] unknown clips released", { projectId: id, taskId: p.task_id, clips: released.rowCount });
      return released.rowCount;
    });
  }
  /** Removes the draft with its final videos. Rows go in this transaction; the caller removes files. */
  async remove(owner: string, id: string) {
    return inTransaction(this.pool, async client => {
      const p = (await client.query(`${select} WHERE p.user_id=$1 AND p.id=$2 FOR UPDATE OF p`, [owner, id])).rows[0];
      if (!p) throw new PresenterError("草稿不存在", 404);
      if (p.task_id) {
        if (["pending", "running"].includes(p.status)) throw new PresenterError("视频正在生成，请先取消，任务结束后再删除。", 409);
        const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [presenterLockKey(p.task_id)]);
        if (!lock.rows[0].locked) throw new PresenterError("原任务正在收尾，请稍后再删除。", 409);
      }
      // Videos of every job of the draft, including those replaced by a recomposed one.
      const files = p.task_id ? (await client.query(`DELETE FROM assets WHERE user_id=$1 AND type='video' AND task_id IN
        (SELECT id FROM tasks WHERE user_id=$1 AND type=$3 AND input->>'projectId'=$2) RETURNING storage_key`, [owner, id, DIGITAL_PRESENTER_TASK])).rows : [];
      await client.query("DELETE FROM digital_presenter_projects WHERE user_id=$1 AND id=$2", [owner, id]);
      return { files: files.map(row => row.storage_key as string) };
    });
  }
  async clips(taskId: string): Promise<ClipRow[]> {
    return (await this.pool.query<ClipRow>("SELECT * FROM digital_presenter_clips WHERE task_id=$1 ORDER BY slot", [taskId])).rows;
  }
}
