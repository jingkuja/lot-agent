import { createHash } from "node:crypto";
import type pg from "pg";
import { MARKETING_COPY_MODEL, MARKETING_REVIEW_MODEL, MarketingDraftSchema, type MarketingDraft } from "@lot-agent/core/marketing-video";
import { MarketingError, reviewText, saveSnapshot } from "./repository.js";
import { marketingReviewDelta } from "./compliance.js";
import type { MarketingTextReceipt } from "./text.js";
import { parseOperationResult, textResultVersion, type TextOperationKind, type TextOperationResult } from "./text-result.js";

export interface TextOperation {
  id: string; kind: TextOperationKind; status: "running" | "unknown" | "needs_apply" | "failed" | "cancelled" | "succeeded" | "conflict" | "released";
  /** When the request started, for showing how long it has run. */
  createdAt?: string;
  result?: TextOperationResult; appliedVersion?: number;
}
// Review and publication metadata stay editable after a video job exists.
const allowedWithTask = (kind: TextOperationKind) => kind === "review" || kind === "publication";
// Longer than the 300 s text request deadline: a running row this old has no live request.
const STALE_RUNNING_MS = 360_000;
// Paid text requests one user may run at once across all drafts.
export const MAX_RUNNING_TEXT_OPERATIONS = 2;
const view = (row: Record<string, any>): TextOperation => ({ id: row.id, kind: row.kind,
  status: row.status === "running" && Date.now() - new Date(row.created_at).getTime() > STALE_RUNNING_MS ? "unknown" : row.status,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined, result: row.result ?? undefined, appliedVersion: row.applied_version ?? undefined });

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
      // The owner lock above makes this count exact for concurrent requests.
      const running = (await client.query(`SELECT count(*)::int AS n FROM marketing_text_operations
        WHERE user_id=$1 AND status='running' AND created_at > now() - make_interval(secs => $2::double precision / 1000)`, [owner, STALE_RUNNING_MS])).rows[0].n;
      if (running >= MAX_RUNNING_TEXT_OPERATIONS) throw new MarketingError("同时进行的 AI 创作过多，请等当前请求完成后再试。", 429);
      const project = (await client.query("SELECT * FROM marketing_video_projects WHERE user_id=$1 AND id=$2 FOR UPDATE", [owner, projectId])).rows[0];
      if (!project) throw new MarketingError("草稿不存在", 404);
      if (project.version !== version || (project.task_id && !allowedWithTask(kind))) throw new MarketingError("草稿已更新，请重新确认。", 409);
      const draft = MarketingDraftSchema.parse(project.draft);
      if (expectedDraft && JSON.stringify(draft) !== JSON.stringify(expectedDraft)) throw new MarketingError("草稿已更新，请重新确认。", 409);
      if ((await client.query("SELECT 1 FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2 AND status IN ('running','unknown','needs_apply')", [owner, projectId])).rowCount) {
        throw new MarketingError("已有创作请求正在处理或结果待核实，请查看页面底部的处理结果。", 409);
      }
      // A review re-checks only what changed since the last applied review in the same language.
      // The delta is frozen with the input, so recovery reproduces the same result; the hash
      // above stays on the request alone, so a repeated request still replays.
      let frozen = input;
      if (kind === "review") {
        const base = (await client.query(`SELECT input_snapshot,result FROM marketing_text_operations WHERE user_id=$1 AND project_id=$2
          AND kind='review' AND status='succeeded' AND parser_version=$3 ORDER BY created_at DESC LIMIT 1`, [owner, projectId, textResultVersion(kind)])).rows[0];
        const delta = base?.result?.review && base.input_snapshot?.input?.locale === (input as { locale?: string }).locale
          ? marketingReviewDelta(draft, { draft: MarketingDraftSchema.parse(base.input_snapshot.draft), review: base.result.review }) : undefined;
        if (delta) frozen = { ...(input as object), delta };
      }
      const row = (await client.query(`INSERT INTO marketing_text_operations(id,user_id,project_id,project_version,kind,input_hash,model,protocol,status,input_snapshot,parser_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,'marketing-json-v1','running',$8,$9) RETURNING *`, [id, owner, projectId, version, kind, hash, kind === "review" ? MARKETING_REVIEW_MODEL : MARKETING_COPY_MODEL, JSON.stringify({ draft, input: frozen }), textResultVersion(kind)])).rows[0];
      return { fresh: true as const, operation: view(row), draft, input: frozen };
    });
  }
  async receipt(owner: string, id: string, receipt: MarketingTextReceipt) {
    await this.pool.query(`UPDATE marketing_text_operations SET receipt=$3,status=CASE WHEN $3::jsonb->>'outcome'='completed' THEN 'needs_apply' ELSE status END,updated_at=now()
      WHERE user_id=$1 AND id=$2 AND status='running'`, [owner, id, JSON.stringify(receipt)]);
  }
  async finish(owner: string, id: string, result: TextOperationResult): Promise<TextOperation> {
    return this.transaction(async client => {
      const row = (await client.query("SELECT * FROM marketing_text_operations WHERE user_id=$1 AND id=$2 FOR UPDATE", [owner, id])).rows[0];
      if (!row) throw new MarketingError("创作记录不存在。", 404);
      // Includes recovery after a COMMIT whose response was lost: query the
      // committed result before considering any repeat local application.
      if (row.result && ["succeeded", "conflict"].includes(row.status)) return view(row);
      if (!["running", "needs_apply"].includes(row.status)) throw new MarketingError("创作记录状态已改变，请重新打开。", 409);
      // Every kind applies only to the project version its input was frozen from.
      const applied = row.kind === "review"
        ? await client.query(`UPDATE marketing_video_projects SET review=$4,reviewed_script=$5
            WHERE user_id=$1 AND id=$2 AND version=$3 RETURNING version`, [owner, row.project_id, row.project_version, JSON.stringify(result.review), reviewText(MarketingDraftSchema.parse(row.input_snapshot.draft))])
        : await client.query(`UPDATE marketing_video_projects SET draft=$4,version=version+1,updated_at=now(),
            review=CASE WHEN reviewed_script=$5 THEN review ELSE NULL END,reviewed_script=CASE WHEN reviewed_script=$5 THEN reviewed_script ELSE NULL END
            WHERE user_id=$1 AND id=$2 AND version=$3 AND ($6::boolean OR task_id IS NULL) RETURNING version`,
          [owner, row.project_id, row.project_version, JSON.stringify(result.draft), reviewText(result.draft!), allowedWithTask(row.kind)]);
      const status = applied.rowCount ? "succeeded" : "conflict";
      // The AI result replaced the copy and storyboard its input was frozen from; keep them to restore.
      if (applied.rowCount && (row.kind === "copy" || row.kind === "storyboard")) {
        await saveSnapshot(client, owner, row.project_id, row.project_version, row.kind, MarketingDraftSchema.parse(row.input_snapshot.draft));
      }
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
    if (row.parser_version !== textResultVersion(row.kind) || !row.input_snapshot) throw new MarketingError("该创作记录需要按原版本核实，已保留回执。", 409);
    let result;
    try {
      const raw = JSON.parse(row.receipt.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      result = parseOperationResult(row.kind, raw, MarketingDraftSchema.parse(row.input_snapshot.draft), row.input_snapshot.input ?? {});
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
      // A received result is recovered, never released, unless its parser or
      // review rules changed so it can no longer be applied.
      const recoverable = row.parser_version === textResultVersion(row.kind);
      if (recoverable && (row.status === "needs_apply" || row.receipt?.outcome === "completed")) throw new MarketingError("结果已收到，正在填入草稿，不收费。", 409);
      const status = view(row).status === "needs_apply" ? "unknown" : view(row).status;
      if (status === "running") throw new MarketingError("创作请求仍在处理，请稍候。", 409);
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
    // `cancelled` means sent with nothing back: kept with its gateway request ID for refund checks.
    const { rows } = await this.pool.query(`UPDATE marketing_text_operations SET status=CASE
      WHEN $4::boolean OR NOT $3::boolean THEN 'failed'
      WHEN receipt->>'outcome'='completed' THEN 'needs_apply'
      WHEN receipt->>'outcome'='cancelled' THEN 'cancelled'
      WHEN receipt->>'outcome' IN ('failed','rejected') THEN 'failed' ELSE 'unknown' END,updated_at=now()
      WHERE user_id=$1 AND id=$2 AND status IN ('running','unknown','needs_apply')
      RETURNING project_id, kind, status, receipt->>'gatewayRequestId' AS gateway_request_id`, [owner, id, started, invalidOutput]);
    if (rows[0]?.status === "cancelled") {
      console.warn("[marketing-video] text request cancelled without response", { operationId: id, projectId: rows[0].project_id, kind: rows[0].kind, gatewayRequestId: rows[0].gateway_request_id ?? null });
    }
  }
}
