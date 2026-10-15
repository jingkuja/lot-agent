/** Regression checks use the caller's disposable local database only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { PgMarketingTextOperations } from "../src/marketing-video/operations.js";
import { PgMarketingProjectStore } from "../src/marketing-video/repository.js";
import { PgAnalysisStore } from "../src/marketing-analysis/repository.js";
import { SecretBox } from "../src/auth/secret-box.js";
import { dispatchAnalyses } from "../src/marketing-analysis/queue.js";
import { analysisConfig } from "../src/marketing-analysis/config.js";
import { AnalysisModels } from "../src/marketing-analysis/models.js";
import { PgAnalysisLedger } from "../src/marketing-analysis/ledger.js";
import { summaryInput } from "../src/marketing-analysis/summary-input.js";

export async function checkReviewFixes(pool: pg.Pool) {
  const owner = randomUUID(), other = randomUUID();
  await pool.query("INSERT INTO users(id,name) VALUES($1,'review fixture'),($2,'other review fixture')", [owner, other]);
  const projects = new PgMarketingProjectStore(pool);
  const operations = new PgMarketingTextOperations(pool);
  const p = await projects.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ topic: "咖啡" }));
  const id = randomUUID(); const input = { version: p.version, locale: "zh" };
  const begin = () => operations.begin(owner, id, p.id, p.version, "copy", input, p.draft);
  const concurrent = await Promise.all([begin(), begin()]);
  assert.equal(concurrent.filter(v => v.fresh).length, 1);
  await assert.rejects(operations.begin(owner, id, p.id, 1, "copy", { changed: true }), /请求标识/);
  await assert.rejects(operations.begin(other, id, p.id, 1, "copy", input), /草稿不存在/);
  await assert.rejects(operations.begin(owner, randomUUID(), p.id, 1, "copy", input), /已有创作请求/);
  const result = { draft: MarketingDraftSchema.parse({ ...p.draft, script: "已付费的结果" }), analysis: "完整结果" };
  await operations.receipt(owner, id, { text: JSON.stringify(result), responseId: "response-fixture", usage: { promptTokens: 1, completionTokens: 2 }, outcome: "completed" });
  await operations.finish(owner, id, result);
  // New repository instance models restart / response loss. Reusing the ID
  // returns the durable result even though the draft version has advanced.
  const restored = await new PgMarketingTextOperations(pool).begin(owner, id, p.id, 1, "copy", input, p.draft);
  assert.equal(restored.fresh, false); assert.deepEqual(restored.operation.result, result);
  assert.equal((await projects.get(owner, p.id))?.version, 2);
  assert.equal((await operations.list(other, p.id)).length, 0);
  const conflictId = randomUUID();
  await operations.begin(owner, conflictId, p.id, 2, "storyboard", { version: 2 });
  await projects.save(owner, p.id, 2, { ...result.draft, topic: "另一页面修改" });
  assert.equal((await operations.finish(owner, conflictId, result)).status, "conflict");
  assert.equal((await projects.get(owner, p.id))?.draft.topic, "另一页面修改");
  assert.deepEqual((await new PgMarketingTextOperations(pool).list(owner, p.id))[0].result, result);
  const unknownId = randomUUID();
  await operations.begin(owner, unknownId, p.id, 3, "copy", { version: 3 });
  await operations.fail(owner, unknownId);
  assert.equal((await operations.list(owner, p.id))[0].status, "unknown");
  await assert.rejects(new PgMarketingTextOperations(pool).begin(owner, randomUUID(), p.id, 3, "copy", {}), /已有创作请求/);

  const analyses = new PgAnalysisStore(pool, new SecretBox("00".repeat(32)));
  const config = analysisConfig({ MARKETING_ANALYSIS_ENABLED: "1", YTDLP_VERSION: "2026.07.04", SECRET_MASTER_KEY: "fixture" });
  const create = (user = owner) => analyses.create(user, { shareText: "https://b23.tv/fixture", clientRequestId: randomUUID() }, config);
  const history = [];
  for (let i = 0; i < 4; i++) { const row = await create(); await analyses.cancel(owner, row.id); history.push(row); }
  const resumed = await Promise.allSettled(history.map(row => analyses.resume(owner, row.id, 1)));
  assert.equal(resumed.filter(r => r.status === "fulfilled").length, 3);
  assert.equal(resumed.filter(r => r.status === "rejected" && r.reason.code === "ANALYSIS_CONCURRENCY_LIMIT").length, 1);
  for (const row of history) await analyses.cancel(owner, row.id);
  // Old backlogs cannot occupy all dispatch candidates for other users.
  const crowded = await create(), waiting = await create(other);
  const sourceId = (await analyses.row(owner, crowded.id)).source_id;
  for (let i = 0; i < 101; i++) {
    const task = randomUUID();
    await pool.query("INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,'marketing.analysis','{}',$2,'lot-media-analysis')", [task, owner]);
    await pool.query(`INSERT INTO marketing_reference_analyses(id,user_id,source_id,client_request_id,input_hash,pipeline_version,snapshot,created_at)
      VALUES($1,$2,$3,$1,'fixture','frames-v1',$4,now()-interval '1 day')`, [task, owner, sourceId, JSON.stringify(crowded.snapshot)]);
  }
  const deliveries: string[] = [];
  await dispatchAnalyses(analyses, { getJob: async () => null, add: async (_name: string, data: { taskId: string }) => { deliveries.push(data.taskId); } } as never);
  assert(deliveries.includes(waiting.id));
  assert.equal(deliveries.filter(task => task !== waiting.id && task !== crowded.id).length <= 1, true);
  await pool.query("UPDATE marketing_reference_analyses SET status='cancelled',cancel_requested=true WHERE user_id=ANY($1)", [[owner, other]]);

  // Real ledger validates the same hash across normal / summary-only recovery.
  const analysis = await create(); const lease = (await analyses.claim(analysis.id))!;
  const frame = { id: "f0001", sourceHash: "a".repeat(64), sourcePts: "0", timeBase: "1/1000", ptsMs: 0, width: 1, height: 1, objectKey: "frame-0001.jpg", reasons: [] };
  const snapshot = { ...analysis.snapshot, source: { ...analysis.snapshot.source, durationMs: 1000 }, frames: [frame], completedVisualBatches: [0],
    coverage: { sampledFrames: 2, ocrFrames: 2, visualFrames: 2, omittedOcrFrameIds: ["f0001"], omittedVisualFrameIds: [], limitations: ["OCR_INCOMPLETE"] },
    observations: [{ description: "product", frameIds: ["f0001"], uncertainty: "" }] };
  let calls = 0;
  const provider = async () => ({ async *chat() {
    calls++; yield { type: "text" as const, content: calls === 1 ? "invalid" : JSON.stringify({ summary: [], timeline: [], marketingPoints: [], limitations: [] }) };
    yield { type: "done" as const, finishReason: "stop", usage: { promptTokens: 2, completionTokens: 2 } };
  } });
  const model = new AnalysisModels({ ledger: new PgAnalysisLedger(analyses, lease), provider, readFrame: async () => new Uint8Array() });
  await analyses.checkpoint(lease, snapshot, "visual");
  await assert.rejects(model.summarize(summaryInput(snapshot, 1)), /MODEL_INVALID_JSON/);
  await analyses.finish(lease, "MODEL_INVALID_JSON"); await analyses.resume(owner, analysis.id, 1, true);
  const next = (await analyses.claim(analysis.id))!;
  const resumedModel = new AnalysisModels({ ledger: new PgAnalysisLedger(analyses, next), provider, readFrame: async () => new Uint8Array() });
  await resumedModel.summarize(summaryInput((await analyses.row(owner, analysis.id)).snapshot, 1));
  assert.equal(calls, 2);
  await analyses.finish(next);
  const fairness = { backlogOwner: owner, otherOwner: other, otherTask: waiting.id };
  console.log("PASS: review regressions: durable text replay/conflict/unknown/ownership, concurrent resume admission, 101-row fair dispatch and real summary ledger recovery");
  return fairness;
}
