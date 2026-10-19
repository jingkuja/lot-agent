import { createHash } from "node:crypto";
import type pg from "pg";
import { MARKETING_COPY_MODEL, MarketingDraftSchema, type MarketingDraft } from "@lot-agent/core/marketing-video";
import { MarketingError } from "./repository.js";
import type { MarketingTextReceipt } from "./text.js";
import { parseTextResult, TEXT_RESULT_VERSION } from "./text-result.js";

export interface TextOperation {
  id: string; kind: "copy" | "storyboard"; status: "running" | "unknown" | "needs_apply" | "failed" | "succeeded" | "conflict" | "released";
  result?: { draft: MarketingDraft; analysis: string }; appliedVersion?: number;
}
// Longer than the 300 s text request deadline: a running row this old has no live request.
const STALE_RUNNING_MS = 360_000;
const view = (row: Record<string, any>): TextOperation => ({ id: row.id, kind: row.kind,
  status: row.status === "running" && Date.now() - new Date(row.created_at).getTime() > STALE_RUNNING_MS ? "unknown" : row.status,
  result: row.result ?? undefined, appliedVersion: row.applied_version ?? undefined });

export class PgMarketingTextOperations {
  constructor(readonly pool: pg.Pool) {}
  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async list(owner: string, projectId: string): Promise<TextOperation[]> {
    return (await this.pool.query("SELECT * FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 10", [owner, projectId])).rows.map(view);
  }
  async begin(owner: string, id: string, projectId: string, version: number, kind: TextOperation["kind"], input: unknown, expectedDraft?: MarketingDraft) {
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.transaction(async client => {
      // Serialize requests for this owner, including concurrent reuse of an ID
      // for different projects. Model work happens after this short transaction.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`marketing-text:${owner}`]);
      const old = (await client.query("SELECT * FROM marketing_text_operations WHERE user_id=$1 AND id=$2", [owner, id])).rows[0];
      if (old) {
        if (old.input_hash !== hash || old.project_id !== projectId || old.kind !== kind) throw new MarketingError("请求标识已用于其他内容，请重新打开草稿。", 409);
        return { fresh: false as const, operation: view(old) };
      }
      const project = (await client.query("SELECT * FROM marketing_video_projects WHERE user_id=$1 AND id=$2 FOR UPDATE", [owner, projectId])).rows[0];
      if (!project) throw new MarketingError("草稿不存在", 404);
      if (project.version !== version || project.task_id) throw new MarketingError("草稿已更新，请重新确认。", 409);
      const draft = MarketingDraftSchema.parse(project.draft);
      if (expectedDraft && JSON.stringify(draft) !== JSON.stringify(expectedDraft)) throw new MarketingError("草稿已更新，请重新确认。", 409);
      if ((await client.query("SELECT 1 FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2 AND status IN ('running','unknown','needs_apply')", [owner, projectId])).rowCount) {
        throw new MarketingError("已有创作请求正在处理或结果待核实，请先查看保存的创作记录。", 409);
      }
      const row = (await client.query(`INSERT INTO marketing_text_operations(id,user_id,project_id,project_version,kind,input_hash,model,protocol,status,input_snapshot,parser_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,'marketing-json-v1','running',$8,$9) RETURNING *`, [id, owner, projectId, version, kind, hash, MARKETING_COPY_MODEL, JSON.stringify({ draft, input }), TEXT_RESULT_VERSION])).rows[0];
      return { fresh: true as const, operation: view(row), draft };
    });
  }
  async receipt(owner: string, id: string, receipt: MarketingTextReceipt) {
    await this.pool.query(`UPDATE marketing_text_operations SET receipt=$3,status=CASE WHEN $3::jsonb->>'outcome'='completed' THEN 'needs_apply' ELSE status END,updated_at=now()
      WHERE user_id=$1 AND id=$2 AND status='running'`, [owner, id, JSON.stringify(receipt)]);
  }
  async finish(owner: string, id: string, result: TextOperation["result"]): Promise<TextOperation> {
    return this.transaction(async client => {
      const row = (await client.query("SELECT * FROM marketing_text_operations WHERE user_id=$1 AND id=$2 FOR UPDATE", [owner, id])).rows[0];
      if (!row) throw new MarketingError("创作记录不存在。", 404);
      // Includes recovery after a COMMIT whose response was lost: query the
      // committed result before considering any repeat local application.
      if (row.result && ["succeeded", "conflict"].includes(row.status)) return view(row);
      if (!["running", "needs_apply"].includes(row.status)) throw new MarketingError("创作记录状态已改变，请重新打开。", 409);
      const applied = await client.query(`UPDATE marketing_video_projects SET draft=$4,version=version+1,review=NULL,reviewed_script=NULL,updated_at=now()
        WHERE user_id=$1 AND id=$2 AND version=$3 AND task_id IS NULL RETURNING version`, [owner, row.project_id, row.project_version, JSON.stringify(result!.draft)]);
      const status = applied.rowCount ? "succeeded" : "conflict";
      const updated = (await client.query(`UPDATE marketing_text_operations SET result=$3,status=$4,applied_version=$5,updated_at=now()
        WHERE user_id=$1 AND id=$2 RETURNING *`, [owner, id, JSON.stringify(result), status, applied.rows[0]?.version ?? null])).rows[0];
      return view(updated);
    });
  }
  async recover(owner: string, projectId: string, id: string): Promise<TextOperation> {
    const row = (await this.pool.query("SELECT * FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2 AND id=$3", [owner, projectId, id])).rows[0];
    if (!row) throw new MarketingError("创作记录不存在。", 404);
    if (row.result && ["succeeded", "conflict"].includes(row.status)) return view(row);
    if (row.receipt?.outcome !== "completed" || !["needs_apply", "running", "unknown"].includes(row.status)) throw new MarketingError("创作结果尚未核实，不能重新调用模型。", 409);
    if (!row.receipt.usage || ![row.receipt.usage.promptTokens, row.receipt.usage.completionTokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new MarketingError("创作结果尚未核实，不能重新调用模型。", 409);
    if (row.parser_version !== TEXT_RESULT_VERSION || !row.input_snapshot) throw new MarketingError("该创作记录需要按原版本核实，已保留回执。", 409);
    let result;
    try {
      const raw = JSON.parse(row.receipt.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      result = parseTextResult(row.kind, raw, MarketingDraftSchema.parse(row.input_snapshot.draft), row.input_snapshot.input?.index);
    } catch (error) { await this.fail(owner, id, true, true); throw new MarketingError("文案或分镜生成不完整，请重试。", 503); }
    await this.pool.query("UPDATE marketing_text_operations SET status='needs_apply',updated_at=now() WHERE user_id=$1 AND id=$2 AND status IN ('running','unknown')", [owner, id]);
    return this.finish(owner, id, result);
  }
  /** The user accepts a possible duplicate charge and unlocks AI creation for the project.
   * The row and its receipt stay for billing reconciliation; a result that is already
   * received must be recovered instead, and a live request cannot be released. */
  async release(owner: string, projectId: string, id: string): Promise<TextOperation> {
    return this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`marketing-text:${owner}`]);
      const row = (await client.query("SELECT * FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE", [owner, projectId, id])).rows[0];
      if (!row) throw new MarketingError("创作记录不存在。", 404);
      if (row.status === "released") return view(row);
      if (row.status === "needs_apply" || row.receipt?.outcome === "completed") throw new MarketingError("创作结果已收到，请恢复已收到的结果，不会再次扣费。", 409);
      const status = view(row).status;
      if (status === "running") throw new MarketingError("创作请求仍在处理，请稍后刷新创作状态。", 409);
      if (status !== "unknown") throw new MarketingError("该创作记录没有待核实的结果。", 409);
      const released = (await client.query(`UPDATE marketing_text_operations SET status='released',released_at=now(),updated_at=now()
        WHERE user_id=$1 AND id=$2 RETURNING *`, [owner, id])).rows[0];
      console.warn("[marketing-video] unknown text operation released", { projectId, operationId: id });
      return view(released);
    });
  }
  async fail(owner: string, id: string, started = true, invalidOutput = false) {
    // A missing receipt includes process/transport failure. Never infer that a
    // call did not happen, and never reopen this intent for another model POST.
    await this.pool.query(`UPDATE marketing_text_operations SET status=CASE
      WHEN $4::boolean OR NOT $3::boolean THEN 'failed'
      WHEN receipt->>'outcome'='completed' THEN 'needs_apply'
      WHEN receipt->>'outcome' IN ('failed','rejected') THEN 'failed' ELSE 'unknown' END,updated_at=now()
      WHERE user_id=$1 AND id=$2 AND status IN ('running','unknown','needs_apply')`, [owner, id, started, invalidOutput]);
  }
}
