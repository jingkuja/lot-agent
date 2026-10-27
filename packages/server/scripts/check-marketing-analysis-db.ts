import { checkReviewFixes } from "./check-marketing-review-fixes.js";
import { checkMarketingUploads } from "./check-marketing-uploads-db.js";
/** Only a NEW disposable local database; no downloads or paid model calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import type { AnalysisSnapshot } from "@lot-agent/core/marketing-analysis";
import { DB } from "../src/db/database.js";
import { migrations } from "../src/db/migrations/index.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { SecretBox } from "../src/auth/secret-box.js";
import { PgAnalysisStore } from "../src/marketing-analysis/repository.js";
import { PgAnalysisLedger } from "../src/marketing-analysis/ledger.js";
import { AnalysisStorage } from "../src/marketing-analysis/storage.js";
import { createAnalysisRoutes } from "../src/marketing-analysis/routes.js";
import { analysisConfig } from "../src/marketing-analysis/config.js";
import { PgMarketingProjectStore } from "../src/marketing-video/repository.js";
import { dispatchAnalyses, analysisQueue, createAnalysisConsumer } from "../src/marketing-analysis/queue.js";
import { knowledgeRedisOptions } from "../src/knowledge/ingestion/config.js";
import { AnalysisError } from "../src/marketing-analysis/errors.js";
import { reconcileAnalysisStep } from "../src/marketing-analysis/reconcile.js";
import { collectAnalysisFiles } from "../src/marketing-analysis/cleanup.js";
import { marketingAnalysisNoResponse } from "../src/db/migrations/0064-marketing-analysis-no-response.js";

const raw = process.env.MARKETING_ANALYSIS_CHECK_DATABASE_URL;
if (!raw) throw new Error("Set MARKETING_ANALYSIS_CHECK_DATABASE_URL to a NEW local media_analysis_check_* database");
const url = new URL(raw);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/media_analysis_check_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Disposable local test database required");
const db = new DB({ host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), max: 8 });
const secrets = new SecretBox("00".repeat(32));
const store = new PgAnalysisStore(db.pool, secrets);
const directory = await mkdtemp(join(tmpdir(), "lot-media-db-")); const storage = new AnalysisStorage(directory);
const config = analysisConfig({ MARKETING_ANALYSIS_ENABLED: "1", YTDLP_VERSION: "2026.07.04", SECRET_MASTER_KEY: "fixture" });
const owner = randomUUID(); const other = randomUUID();
const create = (user = owner, clientRequestId = randomUUID()) => store.create(user, { shareText: "https://www.bilibili.com/video/BV1234567890?p=2", clientRequestId }, config);
try {
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0, "Refusing nonempty database");
  await db.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await runMigrations(db.pool, migrations.filter(m => m.version < 39));
  await db.pool.query("INSERT INTO users(id,name) VALUES($1,'fixture'),($2,'other fixture')", [owner, other]);
  await runMigrations(db.pool, migrations); await runMigrations(db.pool, migrations);
  await db.ensureUserBalance(owner);
  await db.pool.query("UPDATE user_balance SET daily_limit=0,monthly_limit=0 WHERE user_id=$1", [owner]);
  const nonce = randomUUID();
  const [first, duplicate] = await Promise.all([create(owner, nonce), create(owner, nonce)]);
  assert.equal(first.id, duplicate.id); assert.equal((await db.getTask(first.id))?.type, "marketing.analysis");
  assert.equal((await db.pool.query("SELECT queue_name FROM tasks WHERE id=$1", [first.id])).rows[0].queue_name, "lot-media-analysis");
  assert.equal(await store.get(other, first.id), null);
  await assert.rejects(store.cancel(other, first.id), /ANALYSIS_NOT_FOUND/);
  const noLocalLimit = await create(); await store.cancel(owner, noLocalLimit.id);
  await assert.rejects(store.create(owner, { shareText: "https://www.bilibili.com/video/BV1234567890?p=3", clientRequestId: nonce }, config), /REQUEST_CONFLICT/);
  assert((await db.pool.query("SELECT share_text FROM marketing_reference_sources WHERE id=$1", [(await store.row(owner, first.id)).source_id])).rows[0].share_text.startsWith("enc:v1:"));
  await assert.rejects(dispatchAnalyses(store, { getJob: async () => null, add: async () => { throw new Error("redis offline"); } } as never), /redis offline/);
  assert.equal((await store.get(owner, first.id))?.status, "queued");
  const deliveries: string[] = [];
  await dispatchAnalyses(store, { getJob: async () => null, add: async (_name: string, data: { taskId: string }) => { deliveries.push(data.taskId); } } as never);
  assert.deepEqual(deliveries, [first.id]);
  const claims = await Promise.all([store.claim(first.id), store.claim(first.id)]);
  assert.equal(claims.filter(Boolean).length, 1); const lease = claims.find(Boolean)!;
  assert.equal(await store.heartbeat({ ...lease, token: randomUUID() }), false);
  const ledger = new PgAnalysisLedger(store, lease);
  assert.equal(await ledger.begin("ocr:f0001", "hash", "deepseek-v4.1-flash", 1), null);
  assert.equal((await new PgAnalysisLedger(store, lease).begin("ocr:f0001", "hash", "deepseek-v4.1-flash", 1))?.outcome, "request_unknown");
  const receipt = { text: '{"text":"不包邮 99元"}', outcome: "completed" as const, responseId: "fixture-response", usage: { promptTokens: 100, completionTokens: 50 } };
  await ledger.finish("ocr:f0001", receipt); await ledger.finish("ocr:f0001", receipt);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM usage_logs WHERE task_id=$1", [first.id])).rows[0].n, 0);
  assert.equal("budget" in (await store.get(owner, first.id))!, false);
  assert.equal((await db.pool.query("SELECT actual_cost FROM marketing_analysis_steps WHERE analysis_id=$1", [first.id])).rows[0].actual_cost, null);
  await assert.rejects(ledger.begin("visual:0", "hash2", "kimi-k3.1-pro", 49), /ANALYSIS_IMAGE_BUDGET_EXHAUSTED/);
  // Images of steps recorded under the former default model still count after it changed.
  assert.equal(await ledger.begin("visual:0", "hash2", "kimi-k3", 40), null); await ledger.finish("visual:0", receipt);
  await assert.rejects(ledger.begin("visual:1", "hash3", "kimi-k3.1-pro", 9), /ANALYSIS_IMAGE_BUDGET_EXHAUSTED/);
  const snapshot: AnalysisSnapshot = { ...first.snapshot,
    source: { ...first.snapshot.source, durationMs: 1000 },
    frames: [{ id: "f0001", sourceHash: "a".repeat(64), sourcePts: "0", timeBase: "1/1000", ptsMs: 0, width: 100, height: 100, objectKey: "frame-0001.jpg", reasons: ["start"] }],
    frameTexts: [{ frameId: "f0001", rawText: "不包邮 99元" }],
    texts: [{ id: "t0001", rawText: "不包邮 99元", text: "不包邮 99元", frameIds: ["f0001"], firstSeenMs: 0, lastSeenMs: 0 }],
    observations: [], summary: { summary: [{ statement: "不包邮", evidenceIds: ["t0001"], inference: false }], timeline: [], marketingPoints: [], limitations: ["NO_AUDIO_ANALYSIS"] }, summaryRevision: 1,
  };
  await store.checkpoint(lease, snapshot, "summary"); await store.finish(lease);
  assert.equal((await store.get(owner, first.id))?.status, "ready");
  assert.equal(Number((await store.row(owner, first.id)).reserved_cost), 0);
  // A row revised by the former text editor (revision 2) resumes from the summary.
  const revised = { ...snapshot, texts: snapshot.texts.map(t => ({ ...t, text: "不包邮 199元" })) }; delete revised.summary; delete revised.summaryRevision;
  await db.pool.query("UPDATE marketing_reference_analyses SET snapshot=$2,revision=2,version=version+1,status='partial' WHERE id=$1", [first.id, JSON.stringify(revised)]);
  await assert.rejects(store.resume(owner, first.id, 1), /REVISION_CONFLICT/);
  await store.resume(owner, first.id, 2); const lease2 = (await store.claim(first.id))!;
  const ledger2 = new PgAnalysisLedger(store, lease2);
  assert.equal(await ledger2.begin("summary:2", "summary-hash", "kimi-k3.1-pro", 0), null);
  const failed = { text: "cut off", outcome: "failed" as const, usage: { promptTokens: 100, completionTokens: 10 } };
  await ledger2.finish("summary:2", failed);
  // Until the user resumes, the ended step keeps its model and input.
  assert.equal(await ledger2.stepModel("summary:2"), "kimi-k3.1-pro");
  await assert.rejects(ledger2.begin("summary:2", "summary-hash-k3", "kimi-k3", 0), /MODEL_INPUT_CHANGED/);
  await store.finish(lease2, "MODEL_STEP_FAILED");
  assert.equal((await store.get(owner, first.id))?.status, "partial");
  await store.resume(owner, first.id, 2); const lease3 = (await store.claim(first.id))!; const ledger3 = new PgAnalysisLedger(store, lease3);
  // A resumed step whose attempt ended follows the current copy model (kimi-k3.1-pro was retired).
  assert.equal(await ledger3.stepModel("summary:2"), undefined);
  assert.equal(await ledger3.begin("summary:2", "summary-hash-k3", "kimi-k3", 0), null, "explicit resume permits one new known-failed attempt");
  await ledger3.finish("summary:2", { ...receipt, text: "summary" }); await store.finish(lease3);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM marketing_analysis_steps WHERE analysis_id=$1 AND step_id='summary:2'", [first.id])).rows[0].n, 2);
  assert.equal(await ledger3.stepModel("summary:2"), "kimi-k3", "the completed retry is replayed with its own model");
  // A full selection with eight skipped OCR responses used to deadlock on
  // Continue: resume retried skipped OCR and counted all attempts as images.
  const full = await create(); const fullLease = (await store.claim(full.id))!;
  const fullLedger = new PgAnalysisLedger(store, fullLease);
  for (let offset = 0; offset < 120; offset += config.ocrConcurrency) {
    await Promise.all(Array.from({ length: Math.min(config.ocrConcurrency, 120 - offset) }, async (_, index) => {
      const i = offset + index;
      await fullLedger.begin(`ocr:f${String(i + 1).padStart(4, "0")}`, `ocr-${i}`, "deepseek-v4.1-flash", 1);
      await fullLedger.finish(`ocr:f${String(i + 1).padStart(4, "0")}`, i < 8 ? failed : receipt);
    }));
  }
  for (let i = 0; i < 8; i++) {
    await fullLedger.begin(`visual:${i}`, `visual-${i}`, "kimi-k3.1-pro", 6);
    await fullLedger.finish(`visual:${i}`, i === 7 ? failed : receipt);
  }
  await fullLedger.begin("summary:1", "summary-full", "kimi-k3.1-pro", 0);
  await fullLedger.finish("summary:1", failed); await store.finish(fullLease, "MODEL_STEP_FAILED");
  await db.pool.query("UPDATE marketing_analysis_steps SET retry_requested=true WHERE analysis_id=$1 AND receipt->>'outcome'='failed'", [full.id]);
  await store.resume(owner, full.id, 1);
  const resumedLease = (await store.claim(full.id))!; const resumedLedger = new PgAnalysisLedger(store, resumedLease);
  assert.equal((await resumedLedger.begin("ocr:f0001", "ocr-0", "deepseek-v4.1-flash", 1))?.outcome, "failed", "skipped OCR must stay cached on Continue");
  assert.equal(await resumedLedger.begin("visual:7", "visual-7", "kimi-k3.1-pro", 6), null, "retrying the same images must remain possible at the image limit");
  await resumedLedger.finish("visual:7", receipt);
  await assert.rejects(resumedLedger.begin("visual:7", "visual-7", "kimi-k3.1-pro", 5), /MODEL_INPUT_CHANGED/);
  await assert.rejects(resumedLedger.begin("visual:8", "extra-images", "kimi-k3.1-pro", 1), /ANALYSIS_IMAGE_BUDGET_EXHAUSTED/);
  assert.equal(await resumedLedger.begin("summary:1", "summary-full", "kimi-k3.1-pro", 0), null);
  await resumedLedger.finish("summary:1", receipt);
  await resumedLedger.begin("copy:1", "copy-full", "kimi-k3.1-pro", 0); await resumedLedger.finish("copy:1", receipt);
  await store.finish(resumedLease);
  assert.equal((await store.get(owner, full.id))?.status, "ready");
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM marketing_analysis_steps WHERE analysis_id=$1 AND step_id LIKE 'ocr:%'", [full.id])).rows[0].n, 120);
  const projects = new PgMarketingProjectStore(db.pool);
  const project = await projects.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ script: "已有生产口播", reference: "旧参考" }));
  // Link the analysis the way an accepted creation does, keeping the project's reference text.
  await db.pool.query("UPDATE marketing_video_projects SET reference_analysis_id=$3,reference_revision=2,reference_evidence_ids=$4 WHERE user_id=$1 AND id=$2",
    [owner, project.id, first.id, JSON.stringify(["t0001"])]);
  const applied = (await projects.get(owner, project.id))!;
  assert.equal(applied.draft.script, "已有生产口播"); assert.equal(applied.referenceAnalysis?.acceptedRevision, 2);
  await assert.rejects(store.remove(owner, first.id), /ANALYSIS_IN_USE/);
  const clearReference = await projects.save(owner, project.id, applied.version, { ...applied.draft, reference: "手动替换" });
  assert.equal(clearReference.referenceAnalysis, undefined);
  const pending = await create(); const pendingLease = (await store.claim(pending.id))!;
  const pendingLedger = new PgAnalysisLedger(store, pendingLease);
  await pendingLedger.begin("ocr:f0001", "hash", "deepseek-v4.1-flash", 1);
  await pendingLedger.responseId("ocr:f0001", "fixture-response");
  await pendingLedger.finish("ocr:f0001", { text: "partial unconfirmed source text", outcome: "request_unknown", responseId: "fixture-response" });
  await store.cancel(owner, pending.id);
  await assert.rejects(store.checkpoint(pendingLease, pending.snapshot, "ocr"), /ANALYSIS_LEASE_LOST/);
  await store.finish(pendingLease, "PROCESS_CANCELLED");
  const unknown = (await store.get(owner, pending.id))!;
  assert.equal(unknown.status, "cancelled"); assert.equal(unknown.errorCode, "REQUEST_UNKNOWN"); assert.equal("budget" in unknown, false);
  await assert.rejects(store.resume(owner, pending.id, 1), /REQUEST_UNKNOWN/);
  await assert.rejects(store.remove(owner, pending.id), /REQUEST_UNKNOWN/);
  await reconcileAnalysisStep(store, owner, pending.id, "ocr:f0001", 1, { ...receipt, outcome: "failed" }, "Fixture gateway usage verified");
  assert.equal((await store.get(owner, pending.id))?.status, "partial");
  assert.equal(Number((await store.row(owner, pending.id)).reserved_cost), 0);
  await assert.rejects(reconcileAnalysisStep(store, owner, pending.id, "ocr:f0001", 1, receipt, "Cannot overwrite known usage"), /MODEL_RECEIPT_CONFLICT/);
  await store.resume(owner, pending.id, 1);
  assert.equal((await store.get(owner, pending.id))?.status, "queued");
  await store.cancel(owner, pending.id);
  await store.remove(owner, pending.id);
  const scrubbed = (await db.pool.query("SELECT receipt,reconciliation FROM marketing_analysis_steps WHERE analysis_id=$1", [pending.id])).rows[0];
  assert.equal(scrubbed.receipt.text, undefined);
  assert.equal(scrubbed.reconciliation.note, undefined);
  assert.equal(scrubbed.reconciliation.previousReceipt.text, undefined);
  assert.equal(scrubbed.reconciliation.previousReceipt.responseId, "fixture-response", "billing identifiers survive content deletion");
  const cancelled = await create(other); await store.cancel(other, cancelled.id); assert.equal(await store.claim(cancelled.id), null);
  // A call that got nothing back is not charged: the analysis resumes and only that step runs again.
  const silentOwner = randomUUID(); const silent = await create(silentOwner); const silentLease = (await store.claim(silent.id))!;
  const silentLedger = new PgAnalysisLedger(store, silentLease);
  const stepReceipt = async (id: string, step: string) => (await db.pool.query(
    "SELECT receipt FROM marketing_analysis_steps WHERE analysis_id=$1 AND step_id=$2 ORDER BY attempt DESC LIMIT 1", [id, step])).rows[0].receipt;
  assert.equal(await silentLedger.begin("ocr:f0002", "hash2", "deepseek-v4.1-flash", 1), null);
  await silentLedger.requestId("ocr:f0002", "req-merged"); await silentLedger.responseId("ocr:f0002", "resp-merged");
  assert.deepEqual(await stepReceipt(silent.id, "ocr:f0002"), { text: "", outcome: "request_unknown", gatewayRequestId: "req-merged", responseId: "resp-merged" });
  await silentLedger.finish("ocr:f0002", { ...receipt, responseId: "resp-merged", gatewayRequestId: "req-merged" });
  assert.equal(await silentLedger.begin("ocr:f0001", "hash", "deepseek-v4.1-flash", 1), null);
  await silentLedger.requestId("ocr:f0001", "req-silent");
  await silentLedger.finish("ocr:f0001", { text: "", outcome: "cancelled", errorCode: "MODEL_NO_RESPONSE", gatewayRequestId: "req-silent" });
  await store.finish(silentLease, "MODEL_NO_RESPONSE");
  assert.deepEqual([(await store.get(silentOwner, silent.id))?.status, (await store.get(silentOwner, silent.id))?.errorCode], ["failed", "MODEL_NO_RESPONSE"]);
  await store.resume(silentOwner, silent.id, 1);
  const silentRetry = new PgAnalysisLedger(store, (await store.claim(silent.id))!);
  assert.equal(await silentRetry.begin("ocr:f0001", "hash", "deepseek-v4.1-flash", 1), null, "the silent step is sent again");
  assert.equal((await silentRetry.begin("ocr:f0002", "hash2", "deepseek-v4.1-flash", 1))?.outcome, "completed", "completed steps are reused");
  // Migration 64 settles such calls recorded before as unknown; a call that received text stays blocked.
  const stuck = async (text: string) => {
    const user = randomUUID(); const value = await create(user); const lease = (await store.claim(value.id))!;
    const ledger = new PgAnalysisLedger(store, lease); await ledger.begin("visual:0", "hash", "kimi-k3", 1);
    await ledger.finish("visual:0", { text, outcome: "request_unknown" }); await store.finish(lease, "REQUEST_UNKNOWN");
    assert.equal((await store.get(user, value.id))?.errorCode, "REQUEST_UNKNOWN"); return { user, value };
  };
  const silentOld = await stuck(""); const partialOld = await stuck('{"observations":[');
  await marketingAnalysisNoResponse.up(db.pool);
  assert.deepEqual(await stepReceipt(silentOld.value.id, "visual:0"), { text: "", outcome: "cancelled", errorCode: "MODEL_NO_RESPONSE" });
  assert.equal((await store.get(silentOld.user, silentOld.value.id))?.errorCode, "MODEL_NO_RESPONSE");
  assert.equal((await db.pool.query("SELECT error FROM tasks WHERE id=$1", [silentOld.value.id])).rows[0].error, "MODEL_NO_RESPONSE");
  await store.resume(silentOld.user, silentOld.value.id, 1);
  assert.equal((await store.get(partialOld.user, partialOld.value.id))?.errorCode, "REQUEST_UNKNOWN");
  await assert.rejects(store.resume(partialOld.user, partialOld.value.id, 1), /REQUEST_UNKNOWN/);
  await store.cancel(silentOwner, silent.id); await store.cancel(silentOld.user, silentOld.value.id);
  // HTTP authorization is independent of guessed object IDs and filesystem paths.
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", c.req.header("x-test-user") ?? other); await next(); });
  app.route("/", createAnalysisRoutes({ db, tokenhub: {} } as never, directory, { store, storage, config, authorize: async () => {} }));
  assert.equal((await app.request(`/${first.id}`)).status, 404);
  assert.equal((await app.request(`/${first.id}/frames/f0001`)).status, 404);
  await writeFile(join(await storage.directory(owner, first.id), "frame-0001.jpg"), Buffer.from([255, 216, 255, 0]));
  const image = await app.request(`/${first.id}/frames/f0001`, { headers: { "x-test-user": owner } });
  assert.equal(image.status, 200); assert.equal(image.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await app.request(`/${first.id}/frames/f9999`, { headers: { "x-test-user": owner } })).status, 404);
  const ownerJson = { "x-test-user": owner, "Content-Type": "application/json" };
  assert.equal((await app.request(`/${first.id}/resume`, { method: "POST", headers: ownerJson, body: JSON.stringify({ expectedRevision: 1 }) })).status, 409);
  // Editing, summarizing, applying and listing were removed with their unused client paths.
  for (const [method, path] of [["PATCH", "text"], ["POST", "summarize"], ["POST", "apply"], ["POST", "apply-preview"]]) {
    assert.equal((await app.request(`/${first.id}/${path}`, { method, headers: ownerJson, body: "{}" })).status, 404, path);
  }
  assert.equal((await app.request("/", { headers: { "x-test-user": owner } })).status, 404);
  const privateDirectory = await storage.directory(owner, first.id);
  await writeFile(join(privateDirectory, "source.mp4"), "fixture");
  await writeFile(join(privateDirectory, "gray.raw"), "scratch");
  await writeFile(join(privateDirectory, "frame-0361.jpg"), "unused candidate");
  const immutableSelection = (await store.row(owner, first.id)).selection;
  await db.pool.query("UPDATE marketing_reference_analyses SET created_at=now()-interval '8 days',snapshot=jsonb_set(snapshot,'{source,mediaKey}','\"source.mp4\"') WHERE id=$1", [first.id]);
  await collectAnalysisFiles(store, storage);
  await assert.rejects(stat(join(privateDirectory, "source.mp4")), /ENOENT/);
  assert((await stat(join(privateDirectory, "frame-0001.jpg"))).isFile());
  await assert.rejects(stat(join(privateDirectory, "gray.raw")), /ENOENT/);
  await assert.rejects(stat(join(privateDirectory, "frame-0361.jpg")), /ENOENT/);
  assert.deepEqual((await store.row(owner, first.id)).selection, immutableSelection);
  // Rows cleaned by the old source-only collector still reclaim scratch files.
  await writeFile(join(privateDirectory, "gray.raw"), "legacy scratch");
  await db.pool.query("UPDATE marketing_reference_analyses SET scratch_cleaned_at=NULL WHERE id=$1", [first.id]);
  await collectAnalysisFiles(store, storage);
  await assert.rejects(stat(join(privateDirectory, "gray.raw")), /ENOENT/);
  await store.remove(owner, first.id); assert.equal(await store.get(owner, first.id), null);
  await collectAnalysisFiles(store, storage); await assert.rejects(stat(privateDirectory), /ENOENT/);
  assert.equal((await db.pool.query("SELECT 1 FROM marketing_reference_analyses WHERE id=$1 AND deleted_at IS NULL", [first.id])).rowCount, 0);
  // Existing account reassignment updates owned tables in one transaction,
  // with no guaranteed table order. Ownership must still hold at commit.
  const transfer = await db.pool.connect();
  try {
    await transfer.query("BEGIN");
    await transfer.query("UPDATE marketing_analysis_steps SET user_id=$2 WHERE analysis_id=$1", [first.id, other]);
    await transfer.query("UPDATE marketing_reference_analyses SET user_id=$2 WHERE id=$1", [first.id, other]);
    await transfer.query("SET CONSTRAINTS ALL IMMEDIATE");
    await transfer.query("ROLLBACK");
    await transfer.query("BEGIN");
    await transfer.query("UPDATE marketing_analysis_steps SET user_id=$2 WHERE analysis_id=$1", [first.id, other]);
    await assert.rejects(transfer.query("SET CONSTRAINTS ALL IMMEDIATE"), /foreign key constraint/);
  } finally { await transfer.query("ROLLBACK"); transfer.release(); }
  // Single-action video creation: owner/version checks, durable association,
  // atomic result writeback, no local fee calculation, and crash-safe replay.
  const source = "https://www.bilibili.com/video/BV1234567890";
  const newProject = () => projects.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ copyMode: "rewrite", reference: source }));
  const targetProject = await newProject();
  const input = { shareText: source, clientRequestId: randomUUID(), target: { projectId: targetProject.id, projectVersion: targetProject.version, locale: "zh" as const } };
  await assert.rejects(store.create(other, input, config), /PROJECT_NOT_FOUND/);
  await assert.rejects(store.create(owner, { ...input, target: { ...input.target, projectVersion: 99 } }, config), /PROJECT_CONFLICT/);
  const creation = await store.create(owner, input, config);
  assert.equal((await store.create(owner, input, config)).id, creation.id);
  assert.equal((await projects.get(owner, targetProject.id))?.referenceAnalysis?.id, creation.id);
  const creationLease = (await store.claim(creation.id))!;
  const creationLedger = new PgAnalysisLedger(store, creationLease);
  await creationLedger.begin("copy:1", "creation-hash", "kimi-k3.1-pro", 0);
  await creationLedger.finish("copy:1", { text: "", outcome: "rejected", errorCode: "MODEL_QUOTA" });
  await store.finish(creationLease, "MODEL_QUOTA");
  assert.equal((await store.get(owner, creation.id))?.errorCode, "MODEL_QUOTA");
  await store.resume(owner, creation.id, 1);
  const nextLease = (await store.claim(creation.id))!;
  const nextLedger = new PgAnalysisLedger(store, nextLease);
  assert.equal(await nextLedger.begin("copy:1", "creation-hash", "kimi-k3.1-pro", 0), null);
  await nextLedger.finish("copy:1", receipt);
  const output = { draft: MarketingDraftSchema.parse({ ...targetProject.draft, script: "第一句。\n第二句。", storyboard: ["第一句。", "第二句。"].map(script => ({ script, visual: "产品近景", action: "展示产品", camera: "固定镜头" })) }), analysis: "从产品展示切入。" };
  await store.checkpoint(nextLease, { ...creation.snapshot, creation: output }, "copy");
  await store.finish(nextLease);
  const autoApplied = (await projects.get(owner, targetProject.id))!;
  assert.deepEqual(autoApplied.draft, output.draft); assert.equal(autoApplied.version, targetProject.version + 2);
  assert.equal((await store.get(owner, creation.id))?.applied, true);
  await store.resume(owner, creation.id, 1); assert.equal(await store.claim(creation.id), null);
  assert.equal((await projects.get(owner, targetProject.id))?.version, autoApplied.version);
  const conflicting = await newProject();
  const conflictingJob = await store.create(owner, { ...input, clientRequestId: randomUUID(), target: { ...input.target, projectId: conflicting.id } }, config);
  const conflictingLease = (await store.claim(conflictingJob.id))!;
  const latest = (await projects.get(owner, conflicting.id))!;
  await projects.save(owner, latest.id, latest.version, { ...latest.draft, topic: "另一个页面的新要求" });
  await store.checkpoint(conflictingLease, { ...conflictingJob.snapshot, creation: output }, "copy");
  await store.finish(conflictingLease);
  assert.equal((await store.get(owner, conflictingJob.id))?.errorCode, "PROJECT_CONFLICT");
  assert.equal((await projects.get(owner, conflicting.id))?.draft.topic, "另一个页面的新要求");
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM usage_logs")).rows[0].n, 0);
  const fairness = await checkReviewFixes(db.pool);
  const redisUrl = process.env.MARKETING_ANALYSIS_CHECK_REDIS_URL;
  if (redisUrl) {
    const redisAddress = new URL(redisUrl);
    assert(["localhost", "127.0.0.1", "[::1]"].includes(redisAddress.hostname) && redisAddress.pathname === "/15", "Use an empty disposable local Redis database 15");
    const { Redis } = await import("ioredis"); const inspect = new Redis(redisUrl);
    try { assert.equal(await inspect.dbsize(), 0, "Refusing nonempty Redis database"); } finally { inspect.disconnect(); }
    await db.pool.query("UPDATE user_balance SET daily_limit=100,monthly_limit=100 WHERE user_id=$1", [owner]);
    const queue = analysisQueue({ ...knowledgeRedisOptions(redisUrl), maxRetriesPerRequest: 1 });
    const connection = { ...knowledgeRedisOptions(redisUrl), maxRetriesPerRequest: null };
    let concurrent = 0, peak = 0, waitForCancel = "";
    const requests = new Map<string, number>();
    const consume = createAnalysisConsumer(connection, 2, store, async (lease, signal) => {
      concurrent++; peak = Math.max(peak, concurrent);
      try {
        const ledger = new PgAnalysisLedger(store, lease);
        const previous = await ledger.begin("ocr:f0001", "hash", "deepseek-v4.1-flash", 1);
        if (previous) throw new AnalysisError("REQUEST_UNKNOWN", 409);
        requests.set(lease.id, (requests.get(lease.id) ?? 0) + 1);
        if (lease.id === waitForCancel) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        signal.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 50));
        await ledger.finish("ocr:f0001", receipt);
      } finally { concurrent--; }
    });
    async function until(done: () => Promise<boolean>) {
      const deadline = Date.now() + 15000;
      while (!await done()) { if (Date.now() > deadline) throw new Error("Queue integration timed out"); await dispatchAnalyses(store, queue); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    try {
      await db.pool.query("UPDATE marketing_reference_analyses SET status='queued',cancel_requested=false WHERE user_id=ANY($1) AND status='cancelled'", [[fairness.backlogOwner, fairness.otherOwner]]);
      waitForCancel = (await db.pool.query("SELECT id FROM marketing_reference_analyses WHERE user_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1", [fairness.backlogOwner])).rows[0].id;
      await until(async () => requests.has(waitForCancel) && (await store.get(fairness.otherOwner, fairness.otherTask))?.status === "ready");
      assert.equal(peak, 2, "another owner progresses beside a blocked owner's 101-row backlog");
      await db.pool.query("UPDATE marketing_reference_analyses SET status='cancelled',cancel_requested=true WHERE user_id=$1 AND status IN ('queued','running')", [fairness.backlogOwner]);
      await until(async () => !(await store.row(fairness.backlogOwner, waitForCancel)).lease_token);
      waitForCancel = ""; peak = 0;
      const a = await create(); const b = await create();
      await until(async () => (await store.get(owner, a.id))?.status === "ready" && (await store.get(owner, b.id))?.status === "ready");
      assert.equal(peak, 1, "per-owner leases serialize even with worker concurrency=2");
      assert.equal(requests.get(a.id), 1); assert.equal(requests.get(b.id), 1);
      const cancel = await create(); waitForCancel = cancel.id;
      await until(async () => requests.has(cancel.id)); await store.cancel(owner, cancel.id);
      await until(async () => !(await store.row(owner, cancel.id)).lease_token);
      assert.equal((await store.get(owner, cancel.id))?.status, "cancelled");
      const crash = await create(); const lost = (await store.claim(crash.id))!;
      await new PgAnalysisLedger(store, lost).begin("ocr:f0001", "hash", "deepseek-v4.1-flash", 1);
      await db.pool.query("UPDATE marketing_reference_analyses SET lease_until=now()-interval '1 second' WHERE id=$1", [crash.id]);
      await until(async () => (await store.get(owner, crash.id))?.status === "needs_review");
      assert.equal(requests.has(crash.id), false, "expired intents never replay a paid request");
      console.log("PASS: real Redis/BullMQ delivery, per-user concurrency, cross-process cancellation and crash recovery without resubmission");
    } finally { await consume.close(); await queue.close(); }
  }
  await checkMarketingUploads(db.pool, storage);
  console.log("PASS: migrations, duplicate requests, ownership, upstream billing without local budgets, leases, cancellation, unknown calls, explicit retries, automatic copy/storyboard writeback, version conflicts, revisions, private frames and deletion");
} finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
