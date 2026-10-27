/** Regression checks use the caller's disposable local database only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { MARKETING_REVIEW_RULE_VERSION, MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { PgMarketingTextOperations } from "../src/marketing-video/operations.js";
import { PgMarketingProjectStore } from "../src/marketing-video/repository.js";
import { PgAnalysisStore } from "../src/marketing-analysis/repository.js";
import { SecretBox } from "../src/auth/secret-box.js";
import { dispatchAnalyses } from "../src/marketing-analysis/queue.js";
import { analysisConfig } from "../src/marketing-analysis/config.js";
import { AnalysisModels } from "../src/marketing-analysis/models.js";
import { PgAnalysisLedger } from "../src/marketing-analysis/ledger.js";
import { summaryInput } from "../src/marketing-analysis/summary-input.js";
import { checkTextResultRecovery } from "./check-marketing-result-recovery.js";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisStorage } from "../src/marketing-analysis/storage.js";
import { collectAnalysisFiles } from "../src/marketing-analysis/cleanup.js";
import { runAnalysis } from "../src/marketing-analysis/runtime.js";

/** A review after an edit re-checks only the changed fields of the last applied review in the same language. */
export async function checkIncrementalReview(pool: pg.Pool) {
  const owner = randomUUID();
  await pool.query("INSERT INTO users(id,name) VALUES($1,'incremental review fixture')", [owner]);
  const projects = new PgMarketingProjectStore(pool);
  const operations = new PgMarketingTextOperations(pool);
  const shots = [{ script: "第一镜口播。", visual: "门店外景", action: "推门", camera: "中景" }, { script: "第二镜口播。", visual: "产品特写", action: "拿起", camera: "近景" }];
  let p = await projects.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ topic: "门店", script: storyboardScript(shots), storyboard: shots }));
  const first = await operations.begin(owner, randomUUID(), p.id, p.version, "review", { version: p.version, locale: "zh" });
  assert.deepEqual(first.input, { version: p.version, locale: "zh" });
  const carried = { field: "storyboard.visual" as const, shotIndex: 0, text: "门店外景", reason: "需要核实", suggestion: "", severity: "suspect" as const, source: "douyin" as const, ruleId: "platform-misleading-claims" };
  await operations.finish(owner, first.operation.id, { review: { verdict: "suspect", issues: [carried], ruleVersion: MARKETING_REVIEW_RULE_VERSION, reviewedAt: new Date().toISOString() } });
  const edited = [shots[0], { ...shots[1], visual: "产品摆在桌上" }];
  p = await projects.save(owner, p.id, p.version, { ...p.draft, storyboard: edited });
  const requestId = randomUUID();
  const second = await operations.begin(owner, requestId, p.id, p.version, "review", { version: p.version, locale: "zh" });
  assert.deepEqual(second.input, { version: p.version, locale: "zh", delta: { fields: [{ field: "storyboard.visual", shotIndex: 1 }], carried: [carried] } });
  assert.deepEqual((await pool.query("SELECT input_snapshot FROM marketing_text_operations WHERE id=$1", [requestId])).rows[0].input_snapshot.input, second.input);
  await operations.fail(owner, requestId, true, true);
  // Findings written in another language are not reused.
  assert.deepEqual((await operations.begin(owner, randomUUID(), p.id, p.version, "review", { version: p.version, locale: "en" })).input, { version: p.version, locale: "en" });
}

export async function checkReviewFixes(pool: pg.Pool) {
  await checkTextResultRecovery(pool);
  await checkIncrementalReview(pool);
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
  await analyses.finish(lease, "MODEL_INVALID_JSON"); await analyses.resume(owner, analysis.id, 1);
  const next = (await analyses.claim(analysis.id))!;
  const resumedModel = new AnalysisModels({ ledger: new PgAnalysisLedger(analyses, next), provider, readFrame: async () => new Uint8Array() });
  await resumedModel.summarize(summaryInput((await analyses.row(owner, analysis.id)).snapshot, 1));
  assert.equal(calls, 2);
  await analyses.finish(next);
  // New summary inputs carry unprocessed OCR even after quota/auth rejection.
  // JSONB round trips must preserve the model's exact serialized request.
  const coverageJob = await create(); const coverageLease = (await analyses.claim(coverageJob.id))!;
  const secondFrame = { ...frame, id: "f0002", objectKey: "frame-0002.jpg", ptsMs: 500, sourcePts: "500" };
  const coverageSnapshot = { ...coverageJob.snapshot, source: { ...coverageJob.snapshot.source, durationMs: 1000, title: "title", author: "author" },
    frames: [frame, secondFrame], frameTexts: [{ frameId: frame.id, rawText: "coffee" }], completedVisualBatches: [0] };
  const selection = { frames: coverageSnapshot.frames, ocr: coverageSnapshot.frames, visual: coverageSnapshot.frames, durationMs: 1000,
    coverage: { sampledFrames: 2, ocrFrames: 2, visualFrames: 2, omittedOcrFrameIds: [], omittedVisualFrameIds: [], limitations: ["SAMPLED_IMAGES_ONLY", "NO_AUDIO_ANALYSIS"] } };
  await analyses.checkpoint(coverageLease, coverageSnapshot, "ocr", selection);
  const frozen = await analyses.freezeSummaryInput(coverageLease, coverageSnapshot);
  assert(frozen.limitations.includes("OCR_INCOMPLETE"));
  assert.deepEqual((await analyses.row(owner, coverageJob.id)).snapshot.coverage.omittedOcrFrameIds, ["f0002"]);
  let summaryCalls = 0;
  const frozenProvider = async () => ({ async *chat() {
    summaryCalls++; yield { type: "text" as const, content: JSON.stringify({ summary: [], timeline: [], marketingPoints: [], limitations: [] }) };
    yield { type: "done" as const, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
  } });
  const frozenModel = new AnalysisModels({ ledger: new PgAnalysisLedger(analyses, coverageLease), provider: frozenProvider, readFrame: async () => new Uint8Array() });
  await frozenModel.summarize(frozen);
  const reread = (await analyses.row(owner, coverageJob.id)).snapshot;
  reread.frameTexts.push({ frameId: secondFrame.id, rawText: "later" });
  await frozenModel.summarize(await analyses.freezeSummaryInput(coverageLease, reread));
  assert.equal(summaryCalls, 1, "saved summary receipt survives reordered JSONB keys and later processing changes");
  await analyses.finish(coverageLease);
  // A pre-upgrade intent gets its original input, without rewriting its hash.
  const legacyJob = await create(); const legacyLease = (await analyses.claim(legacyJob.id))!;
  const legacySnapshot = { ...coverageSnapshot, coverage: selection.coverage };
  await analyses.checkpoint(legacyLease, legacySnapshot, "ocr", selection);
  const legacyModel = new AnalysisModels({ ledger: new PgAnalysisLedger(analyses, legacyLease), provider: frozenProvider, readFrame: async () => new Uint8Array() });
  await legacyModel.summarize(summaryInput(legacySnapshot, 1));
  const beforeLegacyRecovery = summaryCalls;
  const legacyFrozen = await analyses.freezeSummaryInput(legacyLease, (await analyses.row(owner, legacyJob.id)).snapshot);
  assert(!legacyFrozen.limitations.includes("OCR_INCOMPLETE"));
  await legacyModel.summarize(legacyFrozen);
  assert.equal(summaryCalls, beforeLegacyRecovery);
  await analyses.finish(legacyLease);
  const retentionRoot = await mkdtemp(join(tmpdir(), "lot-review-retention-"));
  const storage = new AnalysisStorage(retentionRoot);
  try {
    for (const receivedSpeech of [false, true]) {
      const sourceJob = await create(); const sourceLease = (await analyses.claim(sourceJob.id))!;
      const sourceSnapshot = { ...coverageSnapshot, source: { ...coverageSnapshot.source, mediaKey: "source.mp4" } };
      await analyses.checkpoint(sourceLease, sourceSnapshot, "frames", selection);
      const sourceDirectory = await storage.directory(owner, sourceJob.id);
      await writeFile(join(sourceDirectory, "source.mp4"), "fixture-private-source");
      await writeFile(join(sourceDirectory, frame.objectKey), "retained frame");
      if (receivedSpeech) {
        const asrLedger = new PgAnalysisLedger(analyses, sourceLease);
        await asrLedger.begin("asr:source", "immutable-audio-hash", "qwen-audio-3.1-asr-flash", 0);
        await asrLedger.finish("asr:source", { text: "已收到的语音", outcome: "completed", usage: { promptTokens: 1, completionTokens: 1 } });
      }
      await analyses.finish(sourceLease, "MODEL_QUOTA");
      await pool.query("UPDATE marketing_reference_analyses SET created_at=now()-interval '8 days' WHERE id=$1", [sourceJob.id]);
      await collectAnalysisFiles(analyses, storage);
      await assert.rejects(stat(join(sourceDirectory, "source.mp4")), /ENOENT/);
      assert((await stat(join(sourceDirectory, frame.objectKey))).isFile());
      if (!receivedSpeech) {
        assert.equal((await analyses.get(owner, sourceJob.id))!.errorCode, "SOURCE_EXPIRED");
        await analyses.resume(owner, sourceJob.id, 1, true);
        assert.deepEqual((await analyses.row(owner, sourceJob.id)).snapshot.speech, { status: "skipped", reason: "SOURCE_EXPIRED" });
        await analyses.cancel(owner, sourceJob.id);
      } else {
        await analyses.resume(owner, sourceJob.id, 1); const restoredLease = (await analyses.claim(sourceJob.id))!;
        const recoveringStore = new Proxy(analyses, { get(target, property) {
          if (property === "checkpoint") return async (...args: Parameters<PgAnalysisStore["checkpoint"]>) => {
            await target.checkpoint(...args);
            if (args[2] === "asr") throw new Error("fixture stop after speech checkpoint");
          };
          const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
        } });
        await assert.rejects(runAnalysis(restoredLease, new AbortController().signal, {
          store: recoveringStore, storage, config,
          db: { getUserApiKey: async () => "fixture" }, hub: { listModels: async () => ({ llm: ["deepseek-v4.1-flash", "kimi-k3.1-pro"] }) },
          baseUrl: "https://never-call.invalid", bridgePath: "/never-run",
          mediaRuntime: { decoderRunner: () => { throw new Error("must not decode expired source"); } },
        } as unknown as Parameters<typeof runAnalysis>[2]), /fixture stop after speech checkpoint/);
        assert.equal((await analyses.row(owner, sourceJob.id)).snapshot.speech.text, "已收到的语音");
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketing_analysis_steps WHERE analysis_id=$1 AND step_id='asr:source'", [sourceJob.id])).rows[0].n, 1);
        await analyses.finish(restoredLease, "FIXTURE_STOP");
      }
    }
  } finally { await rm(retentionRoot, { recursive: true, force: true }); }
  const fairness = { backlogOwner: owner, otherOwner: other, otherTask: waiting.id };
  console.log("PASS: review regressions: durable text replay/conflict/unknown/ownership, concurrent resume admission, 101-row fair dispatch, frozen summary/legacy hash recovery, source expiry and ASR receipt restoration without decoding or resubmission");
  return fairness;
}
