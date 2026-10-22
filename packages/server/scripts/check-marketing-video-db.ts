/** Opt-in integration check. Use a NEW, empty, disposable local database. No paid model calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { KLING_MARKETING_PROFILE, MarketingDraftSchema, planMarketingSegments, resolveMarketingSegments, storyboardScript, type MarketingDraft } from "@lot-agent/core/marketing-video";
import { DB } from "../src/db/database.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { migrations } from "../src/db/migrations/index.js";
import { PgMarketingProjectStore, reviewText } from "../src/marketing-video/repository.js";
import { PgKlingVoiceStore } from "../src/generation/kling-voice-store.js";
import { PgMarketingTextOperations } from "../src/marketing-video/operations.js";
import { runMarketingVideo, type MarketingRunDeps } from "../src/marketing-video/run.js";
import { archiveMarketingVideo } from "../src/marketing-video/archive.js";
import { composeMarketingVideo, ffmpeg, inspectMedia, mediaCapabilities, mediaProcess } from "../src/marketing-video/media.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { UsageMeter } from "../src/billing/meter.js";
import { Hono } from "hono";
import { createMarketingVideoRoutes } from "../src/marketing-video/routes.js";
import { MarketingNarrator } from "../src/marketing-video/narration.js";
import { MarketingKeyArtist } from "../src/marketing-video/key-art.js";
import { AnalysisStorage } from "../src/marketing-analysis/storage.js";
import type { AgentService } from "../src/services/agent-service.js";
import { HttpVideoGenerationProvider, OpenaiVideoAdapter } from "@lot-agent/core";

const raw = process.env.MARKETING_CHECK_DATABASE_URL;
if (!raw) throw new Error("Set MARKETING_CHECK_DATABASE_URL to an empty local database named marketing_check_<suffix>");
const url = new URL(raw);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/marketing_check_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Only an isolated local marketing_check_* database is allowed");
const db = new DB({ host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) });
const store = new PgMarketingProjectStore(db.pool);
const root = await mkdtemp(join(tmpdir(), "lot-marketing-integration-"));
const owner = randomUUID(), other = randomUUID();
const script = "欢迎来到我们的咖啡店。这里有现磨咖啡，也有明亮舒适的座位。你可以约上朋友聊聊天，也可以独自享受一段安静时光。欢迎来店里坐一坐，选择自己喜欢的一杯咖啡。";
const legacyShots = [script.slice(0, 35), script.slice(35)].map(script => ({ script, visual: "人物在咖啡店出镜", action: "人物展示咖啡", camera: "中景" }));
const draft = MarketingDraftSchema.parse({ topic: "咖啡店", storyboard: legacyShots, script: storyboardScript(legacyShots), publishTitle: "欢迎来喝咖啡", tags: "#咖啡 #探店", subtitles: false });
let creates = 0, polls = 0, failSecond = false, unknown = false, downloadFail = false, unconfirmed = false;
const failed = new Set<string>();
const fixture = join(root, "clip.mp4");
const meter = new UsageMeter(db, () => ({ id: "fixture", provider: "fixture", type: "video", unitPrice: 1, inputPrice: 0, outputPrice: 0, enabled: true, billingUnit: "second" }));
const deps: MarketingRunDeps = {
  db, dataRoot: root,
  generation: async (_job, signal) => ({
    modelId: "fixture", vendorModel: "fixture", signal, db, meter,
    cache: { get: async () => null, set: async () => {} },
    storage: { put: async ({ key, body }) => { await writeFile(join(root, "assets", key), body); return { url: `/static/assets/${key}` }; } },
    updateProgress: async () => {}, extFor: () => "mp4", pollIntervalMs: 1,
    urlToBytes: async () => { if (downloadFail) throw new Error("fixture download unavailable"); return { body: await readFile(fixture), mime: "video/mp4" }; },
    provider: {
      create: async (request) => {
        creates++;
        if (unknown) throw new Error("fixture lost submission response");
        const id = randomUUID();
        if (failSecond && request.prompt.startsWith("Create shot 2")) { failed.add(id); failSecond = false; }
        return { taskId: id, status: "queued", progress: 0 };
      },
      poll: async (id) => {
        polls++;
        if (unconfirmed) return { status: "failed", failureUnconfirmed: true, progress: 0, error: "lookup unavailable" };
        return failed.has(id) ? { status: "failed", progress: 0, error: "fixture vendor failure" } : { status: "completed", progress: 100, url: "https://fixture.invalid/video.mp4" };
      },
    },
  }),
};
async function newProject() {
  let p = await store.save(owner, randomUUID(), 0, draft);
  p = await store.setReview(owner, p, { verdict: "pass", issues: [] });
  // Jobs must record a registered clip profile; the provider in deps stays a local fixture.
  const taskId = await store.reserve(owner, p.id, p.version, { modelId: KLING_MARKETING_PROFILE.modelId }, false);
  return { p: (await store.get(owner, p.id))!, taskId };
}
async function run(taskId: string) {
  await db.markTaskRunning(taskId, 1);
  const row = (await db.getTask(taskId))!;
  try {
    const output = await runMarketingVideo(deps, { id: taskId, userId: row.user_id, input: row.input as Record<string, unknown> }, new AbortController().signal);
    await db.setTaskResult(taskId, output); return output;
  } catch (error) { await db.setTaskError(taskId, (error as Error).message, (error as { errorCode?: string }).errorCode); throw error; }
}
try {
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0, "Refusing a nonempty database");
  await db.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await runMigrations(db.pool, migrations.filter(m => m.version < 36));
  await db.pool.query("INSERT INTO users(id,name) VALUES($1,'marketing fixture'),($2,'other fixture')", [owner, other]);
  await runMigrations(db.pool, migrations.filter(m => m.version < 47));
  const oldMaterials = Array.from({ length: 5 }, () => randomUUID());
  for (const [index, id] of oldMaterials.entries()) {
    await db.pool.query("INSERT INTO assets(id,user_id,type,storage_key,url,mime,size_bytes) VALUES($1,$2,'upload',$3,$4,'image/png',1)",
      [id, index === 3 ? other : owner, `${id}.png`, `/static/uploads/${id}.png`]);
  }
  const oldProject = randomUUID(), oldTask = randomUUID();
  await db.pool.query("INSERT INTO marketing_video_projects(id,user_id,draft) VALUES($1,$2,$3)",
    [oldProject, owner, { assets: { portrait: [oldMaterials[0].toUpperCase()], voice: oldMaterials[1], background: oldMaterials[3] } }]);
  await db.createTask(oldTask, "marketing.video", { draft: { assets: { scene: [oldMaterials[2]] } } }, owner);
  await runMigrations(db.pool, migrations); await runMigrations(db.pool, migrations);
  assert.deepEqual(await Promise.all(oldMaterials.map(async id => (await db.getAsset(id))!.is_private)), [true, true, true, false, false], "Backfill covers scalar/array and frozen inputs, without touching foreign or unrelated uploads");
  await db.protectMarketingUpload(oldMaterials[4], other);
  assert.equal((await db.getAsset(oldMaterials[4]))!.is_private, false);
  await db.protectMarketingUpload(oldMaterials[4], owner);
  assert.equal((await db.getAsset(oldMaterials[4]))!.is_private, true);
  assert.equal((await db.getTask(oldTask))!.input.draft.assets.scene[0], oldMaterials[2], "Frozen input identity is unchanged");
  await db.pool.query("DELETE FROM marketing_video_projects WHERE id=$1", [oldProject]);
  await db.pool.query("DELETE FROM tasks WHERE id=$1", [oldTask]);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE id=ANY($1::uuid[])", [[owner, other]])).rows[0].n, 2);
  await mkdir(join(root, "assets")); await mkdir(join(root, "uploads"));
  await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=256x144:r=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "15", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture]);
  const caps = await mediaCapabilities(); assert(caps.composition);
  let p = await store.save(owner, randomUUID(), 0, draft);
  assert.equal(await store.get(other, p.id), null);
  await assert.rejects(store.save(other, p.id, p.version, draft));
  await assert.rejects(store.save(owner, p.id, 0, draft), /其他页面/);
  await assert.rejects(store.reserve(owner, p.id, p.version, {}, false), /文案检查/);
  p = await store.setReview(owner, p, { verdict: "reject", issues: [] });
  await assert.rejects(store.reserve(owner, p.id, p.version, {}, false), /文案检查/);
  p = await store.setReview(owner, p, { verdict: "pass", issues: [] });
  const ids = await Promise.all([store.reserve(owner, p.id, p.version, {}, false), store.reserve(owner, p.id, p.version, {}, false)]);
  assert.equal(ids[0], ids[1]); assert.equal((await store.segments(owner, p.id)).length, 2);
  assert.equal((await store.segments(other, p.id)).length, 0);
  await assert.rejects(store.save(owner, p.id, p.version, { ...draft, durationSec: 60 }), /不可修改/);
  const changed = await store.save(owner, p.id, p.version, { ...draft, publishTitle: "新标题" });
  assert.equal(changed.review, null);
  await assert.rejects(store.setReview(owner, p, { verdict: "pass", issues: [] }), /已更新/);

  const one = await newProject(); failSecond = true;
  await assert.rejects(run(one.taskId), /fixture vendor failure/);
  assert.equal((await store.get(owner, one.p.id))!.errorCode, "GENERATION_FAILED");
  assert.equal(creates, 2); assert.equal((await store.segments(owner, one.p.id)).filter(s => s.status === "succeeded").length, 1);
  await store.reserve(owner, one.p.id, one.p.version, {}, true);
  const output = await run(one.taskId);
  assert.equal(creates, 3, "only the failed clip is regenerated");
  assert(Math.abs((await inspectMedia(join(root, "assets", (await db.getAsset(output.assetIds[0]))!.storage_key))).duration - 30) < 0.05);
  const charged = await db.pool.query("SELECT count(*)::int AS n,sum(output_count)::int AS seconds FROM usage_logs");
  assert.deepEqual(charged.rows[0], { n: 2, seconds: 30 });
  await runMarketingVideo(deps, { id: one.taskId, userId: owner, input: (await db.getTask(one.taskId))!.input as Record<string, unknown> }, new AbortController().signal);
  assert.equal(creates, 3); assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM usage_logs")).rows[0].n, 2);
  // Recover from an asset committed just before a process lost its billing response.
  const children = await store.segments(owner, one.p.id);
  const vendor = children[0].vendor_task_id;
  await Promise.all([meter.record({ userId: owner, taskId: children[0].task_id, modelId: "fixture", usage: { inputCount: 0, outputCount: 15 }, idempotencyKey: `marketing:${children[0].task_id}:${vendor}` }), meter.record({ userId: owner, taskId: children[0].task_id, modelId: "fixture", usage: { inputCount: 0, outputCount: 15 }, idempotencyKey: `marketing:${children[0].task_id}:${vendor}` })]);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM usage_logs")).rows[0].n, 2);

  const archived = await archiveMarketingVideo(store, owner, one.p.id, root);
  assert.equal((await archiveMarketingVideo(store, owner, one.p.id, root)).itemId, archived.itemId);
  const edited = await store.save(owner, one.p.id, one.p.version, { ...draft, publishTitle: "更新后的标题", tags: "#咖啡 #咖啡" });
  await archiveMarketingVideo(store, owner, one.p.id, root);
  const knowledge = new KnowledgeRepository(db.pool), item = await knowledge.getItem(owner, archived.itemId);
  assert.equal(item.title, "更新后的标题"); assert(item.description.includes("#咖啡 #咖啡")); assert.equal((await store.get(owner, one.p.id))!.knowledgeVersion, edited.version);
  await assert.rejects(archiveMarketingVideo(store, other, one.p.id, root), /不存在/);
  await knowledge.deleteItem(owner, item.id, item.version);
  assert.notEqual((await archiveMarketingVideo(store, owner, one.p.id, root)).itemId, item.id, "deleted archive can be recreated");

  const two = await newProject(); unknown = true;
  await assert.rejects(run(two.taskId), /结果未知/); unknown = false;
  let before = creates;
  await store.reserve(owner, two.p.id, two.p.version, {}, true);
  await assert.rejects(run(two.taskId), /结果未知/); assert.equal(creates, before);
  // The user's confirmed release is the exit: owner-scoped, audited, and only
  // clips without a finished or known vendor task are submitted again.
  const twoSegments = await store.segments(owner, two.p.id);
  const unknownClips = twoSegments.filter(s => s.vendor_task_id === "marketing-submission-unknown").length;
  assert(unknownClips >= 1);
  assert.equal((await store.get(owner, two.p.id))!.unknownSegments, unknownClips);
  // The polled state carries the same task fields as the full project, without the draft or materials.
  const full = (await store.get(owner, two.p.id))!;
  const taskFields = ["id", "version", "taskId", "status", "progress", "stage", "error", "errorCode", "output", "unknownSegments"] as const;
  assert.deepEqual(await store.taskState(owner, two.p.id), Object.fromEntries(taskFields.map(key => [key, full[key]])));
  assert.equal(full.errorCode, "SUBMISSION_UNKNOWN");
  assert.equal(await store.taskState("someone-else", two.p.id), null);
  assert.equal((await store.list(owner)).find(p => p.id === two.p.id)!.unknownSegments, unknownClips);
  await assert.rejects(store.releaseUnknownSegments(other, two.p.id), /不存在/);
  const holder = await db.pool.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`marketing:${two.taskId}`]);
    await assert.rejects(store.releaseUnknownSegments(owner, two.p.id), /收尾/);
  } finally { await holder.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`marketing:${two.taskId}`]); holder.release(); }
  assert.equal(await store.releaseUnknownSegments(owner, two.p.id), unknownClips);
  await assert.rejects(store.releaseUnknownSegments(owner, two.p.id), /没有结果未知/);
  assert.equal((await store.get(owner, two.p.id))!.unknownSegments, undefined);
  assert.equal((await db.pool.query("SELECT sum(unknown_released_count)::int AS n FROM marketing_video_segments WHERE project_id=$1 AND unknown_released_at IS NOT NULL", [two.p.id])).rows[0].n, unknownClips);
  const resubmit = twoSegments.filter(s => s.status !== "succeeded").length;
  await store.reserve(owner, two.p.id, two.p.version, {}, true);
  await run(two.taskId); assert.equal(creates, before + resubmit, "only unfinished clips are submitted again");
  before = creates;

  // G04: redo single shots of a made video. Kept clips need no model call or charge,
  // and deleting the draft also removes the earlier jobs' final videos and clips.
  let made = await store.setReview(owner, await store.save(owner, randomUUID(), 0, draft), { verdict: "pass", issues: [] });
  const firstJob = await store.reserve(owner, made.id, made.version, { modelId: KLING_MARKETING_PROFILE.modelId, marketingInputVersion: 3 }, false);
  assert.equal((await store.get(owner, made.id))!.revision, undefined, "a queued job cannot be revised");
  await run(firstJob);
  before = creates;
  made = (await store.get(owner, made.id))!;
  assert.deepEqual(made.revision?.reusable, [true, true]);
  const firstClips = await store.segments(owner, made.id);
  await assert.rejects(store.save(owner, made.id, made.version, { ...made.draft, ratio: "16:9" }), /只能修改分镜/);
  await assert.rejects(store.save(owner, made.id, made.version, { ...made.draft, storyboard: made.draft.storyboard.map(shot => ({ ...shot, durationSec: shot.durationSec - 1 })) }), /只能修改分镜/);
  made = await store.save(owner, made.id, made.version, { ...made.draft, storyboard: made.draft.storyboard.map((shot, i) => i === 1 ? { ...shot, visual: "人物在窗边喝咖啡" } : shot) });
  assert.equal(made.review, null, "an edited shot needs a new text check");
  await assert.rejects(store.revise(owner, made.id, made.version, firstJob, [1]), /文案检查/);
  made = await store.setReview(owner, made, { verdict: "pass", issues: [] });
  await assert.rejects(store.revise(owner, made.id, made.version, firstJob, [0]), /重新选择/, "an edited shot is never kept");
  await assert.rejects(store.revise(other, made.id, made.version, firstJob, [1]), /不存在/);
  const charges = async () => (await db.pool.query("SELECT count(*)::int AS n,COALESCE(sum(output_count),0)::int AS seconds FROM usage_logs WHERE user_id=$1", [owner])).rows[0];
  const chargedBefore = await charges();
  const secondJob = await store.revise(owner, made.id, made.version, firstJob, [1]);
  await assert.rejects(store.revise(owner, made.id, made.version, firstJob, [1]), /已更新/, "a repeated request creates no second job");
  assert.equal((await store.get(owner, made.id))!.revision, undefined);
  const revised = await run(secondJob);
  assert.equal(creates, before + 1, "only the redone shot is submitted");
  assert.deepEqual(await charges(), { n: chargedBefore.n + 1, seconds: chargedBefore.seconds + 15 });
  assert(Math.abs((await inspectMedia(join(root, "assets", (await db.getAsset(revised.assetIds[0]))!.storage_key))).duration - 30) < 0.05);
  const secondClips = await store.segments(owner, made.id);
  assert.deepEqual(secondClips[0].output.assetIds, firstClips[0].output.assetIds);
  assert.equal(secondClips[0].output.reusedFrom, firstClips[0].task_id);
  assert.notDeepEqual(secondClips[1].output.assetIds, firstClips[1].output.assetIds);
  // Redo the same shot unchanged: the kept clip still names the task that made it.
  made = (await store.get(owner, made.id))!;
  const thirdJob = await store.revise(owner, made.id, made.version, secondJob, [1]);
  await run(thirdJob);
  assert.equal(creates, before + 2);
  assert.equal((await store.segments(owner, made.id))[0].output.reusedFrom, firstClips[0].task_id);
  before = creates;
  // Composition-only change: every clip is kept and nothing is submitted or billed.
  made = (await store.get(owner, made.id))!;
  await assert.rejects(store.revise(owner, made.id, made.version, thirdJob, []), /无需重新合成/);
  made = await store.save(owner, made.id, made.version, { ...made.draft, musicVolume: 0.3 });
  assert.equal(made.review?.verdict, "pass", "music is not part of the text check");
  const chargedBeforeRecompose = await charges();
  const fourthJob = await store.revise(owner, made.id, made.version, thirdJob, []);
  await run(fourthJob);
  assert.equal(creates, before, "composing again submits no clip");
  assert.deepEqual(await charges(), chargedBeforeRecompose);
  assert((await store.segments(owner, made.id)).every(segment => segment.output.reusedFrom));
  const madeFiles = (await db.pool.query(`SELECT size_bytes FROM assets WHERE user_id=$1 AND type='video' AND task_id IN (
    SELECT id FROM tasks WHERE id=ANY($2::uuid[]) OR input->>'parentId'=ANY($3::text[]))`, [owner, [firstJob, secondJob, thirdJob, fourthJob], [firstJob, secondJob, thirdJob, fourthJob]])).rows;
  assert.equal(madeFiles.length, 8, "four final videos, two first clips and two redone clips");
  const usageBeforeRevisionDelete = await store.usage(owner);
  const removedRevision = await store.remove(owner, made.id);
  assert.equal(removedRevision.files.length, 8);
  assert.equal(removedRevision.removedBytes, madeFiles.reduce((sum, row) => sum + Number(row.size_bytes), 0));
  assert.equal((await store.usage(owner)).videoBytes, usageBeforeRevisionDelete.videoBytes - removedRevision.removedBytes);

  // Unknown text creation: a live request cannot be released, a received result
  // must be recovered, and a released intent never applies a late result.
  const ops = new PgMarketingTextOperations(db.pool);
  const textProject = await store.save(owner, randomUUID(), 0, draft);
  const firstOp = randomUUID();
  await ops.begin(owner, firstOp, textProject.id, textProject.version, "copy", { n: 1 });
  await assert.rejects(ops.release(owner, textProject.id, firstOp), /仍在处理/);
  await ops.fail(owner, firstOp, true);
  assert.equal((await ops.list(owner, textProject.id))[0].status, "unknown");
  await assert.rejects(ops.begin(owner, randomUUID(), textProject.id, textProject.version, "copy", { n: 2 }), /待核实/);
  await assert.rejects(ops.release(other, textProject.id, firstOp), /不存在/);
  assert.equal((await ops.release(owner, textProject.id, firstOp)).status, "released");
  assert.equal((await ops.release(owner, textProject.id, firstOp)).status, "released");
  assert.notEqual((await db.pool.query("SELECT released_at FROM marketing_text_operations WHERE id=$1", [firstOp])).rows[0].released_at, null);
  await assert.rejects(ops.finish(owner, firstOp, { draft, analysis: "late" }), /状态已改变/);
  assert.equal((await store.get(owner, textProject.id))!.version, textProject.version);
  // A request with nothing back ends cancelled: retryable at once, and its gateway request ID
  // stays on record to match a rare charge for refund.
  const cancelledOp = randomUUID();
  await ops.begin(owner, cancelledOp, textProject.id, textProject.version, "copy", { n: "cancelled" });
  await ops.receipt(owner, cancelledOp, { text: "", outcome: "cancelled", gatewayRequestId: "20261021100000fixture" });
  await ops.fail(owner, cancelledOp, true, false);
  assert.equal((await ops.list(owner, textProject.id))[0].status, "cancelled");
  assert.equal((await db.pool.query("SELECT receipt->>'gatewayRequestId' AS id FROM marketing_text_operations WHERE id=$1 AND status='cancelled'", [cancelledOp])).rows[0].id, "20261021100000fixture");
  const afterCancelled = randomUUID();
  await ops.begin(owner, afterCancelled, textProject.id, textProject.version, "copy", { n: "retry" });
  await ops.fail(owner, afterCancelled, false);
  const staleOp = randomUUID();
  assert.equal((await ops.begin(owner, staleOp, textProject.id, textProject.version, "copy", { n: 2 })).fresh, true);
  await db.pool.query("UPDATE marketing_text_operations SET created_at=now()-interval '7 minutes' WHERE id=$1", [staleOp]);
  assert.equal((await ops.release(owner, textProject.id, staleOp)).status, "released", "a running row older than the request deadline has no live request");
  const receivedOp = randomUUID();
  await ops.begin(owner, receivedOp, textProject.id, textProject.version, "copy", { n: 3 });
  await ops.receipt(owner, receivedOp, { text: "{}", outcome: "completed", usage: { promptTokens: 1, completionTokens: 1 } });
  await assert.rejects(ops.release(owner, textProject.id, receivedOp), /已收到/);
  const failedProject = await store.save(owner, randomUUID(), 0, draft), failedOp = randomUUID();
  await ops.begin(owner, failedOp, failedProject.id, failedProject.version, "copy", { n: 4 });
  await ops.fail(owner, failedOp, false);
  await assert.rejects(ops.release(owner, failedProject.id, failedOp), /没有待核实/);
  const removable = await store.save(owner, randomUUID(), 0, draft);
  await store.remove(owner, removable.id); assert.equal(await store.get(owner, removable.id), null);

  const three = await newProject(); await db.cancelTask(three.taskId);
  await assert.rejects(runMarketingVideo(deps, { id: three.taskId, userId: owner, input: (await db.getTask(three.taskId))!.input as Record<string, unknown> }, new AbortController().signal), /cancelled/);
  assert.equal(creates, before);
  const held = await db.pool.connect();
  try {
    await held.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`marketing:${three.taskId}`]);
    await assert.rejects(store.reserve(owner, three.p.id, three.p.version, {}, true), /收尾/);
  } finally { await held.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`marketing:${three.taskId}`]); held.release(); }

  const four = await newProject(); downloadFail = true;
  await assert.rejects(run(four.taskId), /下载未完成/); downloadFail = false;
  const sent = creates; await store.reserve(owner, four.p.id, four.p.version, {}, true);
  await run(four.taskId); assert.equal(creates, sent, "download retries reuse vendor tasks");

  const five = await newProject(); unconfirmed = true;
  await assert.rejects(run(five.taskId), /暂时无法确认/); unconfirmed = false;
  const sentBeforeLookup = creates; await store.reserve(owner, five.p.id, five.p.version, {}, true);
  await run(five.taskId); assert.equal(creates, sentBeforeLookup, "ambiguous lookup errors must not trigger another paid POST");

  // Variable timing survives reservation, worker inputs, retry and composition.
  const timedShots = [4, 6, 7].map(durationSec => ({ durationSec, script: "欢迎来喝咖啡。", visual: "人物正面出镜", action: "人物端起咖啡", camera: "中景" }));
  for (const [target, timings] of [[17, [4, 6, 7]], [60, [13, 13, 13, 13, 13]]] as const) {
    const storyboard = timings.map(durationSec => ({ ...timedShots[0], durationSec }));
    const timedDraft = MarketingDraftSchema.parse({ durationSec: target, storyboard, script: storyboardScript(storyboard) });
    let timed = await store.save(owner, randomUUID(), 0, timedDraft);
    timed = await store.setReview(owner, timed, { verdict: "pass", issues: [] });
    const timedTask = await store.reserve(owner, timed.id, timed.version, { modelId: KLING_MARKETING_PROFILE.modelId }, false);
    assert.deepEqual((await store.segments(owner, timed.id)).map(s => Number(s.duration_sec)), timings);
    const actualDurations: number[] = [];
    const generate = deps.generation;
    deps.generation = async (job, signal) => {
      const gen = await generate(job, signal);
      return { ...gen, provider: { ...gen.provider, create: async request => {
        const index = Number(/^Create shot (\d+) /.exec(request.prompt)?.[1]) - 1;
        assert(Number.isInteger(index) && index >= 0);
        actualDurations[index] = Number(request.durationSec);
        return gen.provider.create(request);
      } } };
    };
    const timedOutput = await run(timedTask);
    assert.deepEqual(actualDurations, timings);
    const asset = (await db.getAsset(timedOutput.assetIds[0]))!;
    const actualTotal = timings.reduce((sum: number, n) => sum + n, 0);
    assert(Math.abs(Number(asset.duration_sec) - actualTotal) < 0.3);
    assert(Math.abs((await inspectMedia(join(root, "assets", asset.storage_key))).duration - actualTotal) < 0.3);
    assert.equal((await store.get(owner, timed.id))!.draft.durationSec, target, "Keep the chosen target separate from the actual video duration");
    deps.generation = generate;
  }
  // Reject a 70s plan before enqueueing or making any paid video request.
  const oversizedShots = Array.from({ length: 5 }, () => ({ ...timedShots[0], durationSec: 14 }));
  let oversized = await store.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ durationSec: 60, storyboard: oversizedShots, script: storyboardScript(oversizedShots) }));
  oversized = await store.setReview(owner, oversized, { verdict: "pass", issues: [] });
  const tasksBefore = (await db.pool.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n;
  await assert.rejects(store.reserve(owner, oversized.id, oversized.version, { modelId: KLING_MARKETING_PROFILE.modelId }, false), /分镜总时长/);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n, tasksBefore);
  assert.equal((await store.get(owner, oversized.id))!.taskId, null);
  // Even corrupted persisted durations are rejected before provider resolution.
  const validShots = oversizedShots.map(s => ({ ...s, durationSec: 13 }));
  let corrupted = await store.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ durationSec: 60, storyboard: validShots, script: storyboardScript(validShots) }));
  corrupted = await store.setReview(owner, corrupted, { verdict: "pass", issues: [] });
  const corruptTask = await store.reserve(owner, corrupted.id, corrupted.version, { modelId: KLING_MARKETING_PROFILE.modelId }, false);
  await db.pool.query("UPDATE marketing_video_segments SET duration_sec=14 WHERE project_id=$1", [corrupted.id]);
  let resolved = 0; const originalGeneration = deps.generation;
  deps.generation = async () => { resolved++; throw new Error("must not resolve provider for oversized video"); };
  await assert.rejects(run(corruptTask), /视频分段配置不完整/);
  assert.equal(resolved, 0);
  deps.generation = originalGeneration;
  // Upgrade an already submitted pre-v2 WebM job. Its frozen audio options
  // and narration survive current reference-video restrictions and retries.
  let oldVideo = await store.save(owner, randomUUID(), 0, { ...draft, assets: { video: randomUUID(), voice: randomUUID() } });
  for (const [slot, id] of Object.entries(oldVideo.draft.assets)) {
    await db.pool.query("INSERT INTO assets(id,user_id,type,storage_key,url,mime,size_bytes) VALUES($1,$2,'upload',$3,$4,$5,100)",
      [id, owner, `${id}.${slot === "video" ? "webm" : "wav"}`, `/static/uploads/${id}`, slot === "video" ? "video/webm" : "audio/wav"]);
  }
  oldVideo = await store.setReview(owner, oldVideo, { verdict: "pass", issues: [] });
  const oldVideoTask = await store.reserve(owner, oldVideo.id, oldVideo.version, { modelId: KLING_MARKETING_PROFILE.modelId, generate_audio: true, reference_video: ["https://fixture.invalid/legacy.webm"], reference_audio: ["https://fixture.invalid/voice.wav"] }, false);
  const capturedInputs: Record<string, unknown>[] = [];
  deps.generation = async (job, signal) => { capturedInputs.push(job.input); return originalGeneration(job, signal); };
  downloadFail = true;
  await assert.rejects(run(oldVideoTask), /下载未完成/);
  downloadFail = false;
  assert(capturedInputs.length > 1);
  for (const input of capturedInputs) {
    assert.equal(input.generate_audio, true);
    assert.deepEqual(input.reference_audio, ["https://fixture.invalid/voice.wav"]);
  }
  const oldSent = creates;
  const frozenBefore = (await db.getTask(oldVideoTask))!.input;
  const receiptsBefore = (await store.segments(owner, oldVideo.id)).map(s => [s.task_id, s.vendor_task_id]);
  let delivered: string | undefined;
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", owner); await next(); });
  app.route("/marketing", createMarketingVideoRoutes({ db,
    jobQueue: { canResumePersisted: async () => true, deliverPersisted: async (id: string) => { delivered = id; } },
    usageMeter: { checkQuota: async () => { throw new Error("known receipts must not require a new quota"); } },
    modelRegistry: { getConfig: () => undefined }, modelCatalog: { defaultPricing: {}, pricing: {} },
  } as unknown as AgentService, root, store));
  const resumed = await app.request(`/marketing/${oldVideo.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: oldVideo.version, retry: true }) });
  assert.equal(resumed.status, 202, await resumed.text());
  assert.equal(delivered, oldVideoTask);
  assert.deepEqual((await db.getTask(oldVideoTask))!.input, frozenBefore);
  await run(oldVideoTask); assert.equal(creates, oldSent);
  assert.deepEqual((await store.segments(owner, oldVideo.id)).map(s => [s.task_id, s.vendor_task_id]), receiptsBefore);
  deps.generation = originalGeneration;

  // Deleting a draft removes its generated clips and final video and the analyses made
  // for it; an analysis with an unverified model request keeps its record.
  const doomed = (await store.get(owner, oldVideo.id))!;
  const generated = (await db.pool.query(`SELECT id, storage_key, size_bytes FROM assets WHERE user_id=$1 AND type='video'
    AND task_id IN (SELECT $2::uuid UNION SELECT task_id FROM marketing_video_segments WHERE project_id=$3)`, [owner, doomed.taskId, doomed.id])).rows;
  const generatedBytes = generated.reduce((sum, row) => sum + Number(row.size_bytes), 0);
  assert(generated.length > 1, "clips and the final video");
  for (const row of generated) await readFile(join(root, "assets", row.storage_key));
  const usageBefore = await (await app.request("/marketing/usage")).json() as { videoBytes: number; analysisBytes: number };
  assert(usageBefore.videoBytes >= generatedBytes);
  const analysisStorage = new AnalysisStorage(join(root, "marketing-analysis"));
  const [doomedAnalysis, unverifiedAnalysis] = [randomUUID(), randomUUID()];
  for (const analysisId of [doomedAnalysis, unverifiedAnalysis]) {
    const sourceId = randomUUID();
    await db.pool.query("INSERT INTO marketing_reference_sources(id,user_id,share_text,platform) VALUES($1,$2,'sealed','douyin')", [sourceId, owner]);
    await db.pool.query("INSERT INTO tasks(id,type,input,user_id) VALUES($1,'marketing.analysis','{}',$2)", [analysisId, owner]);
    await db.pool.query(`INSERT INTO marketing_reference_analyses(id,user_id,source_id,client_request_id,input_hash,pipeline_version,status,snapshot,creation_context)
      VALUES($1,$2,$3,$4,'hash','fixture','ready','{"frames":[]}',$5)`, [analysisId, owner, sourceId, randomUUID(), JSON.stringify({ projectId: doomed.id })]);
    await writeFile(join(await analysisStorage.directory(owner, analysisId), "frame-0001.jpg"), "frame");
  }
  await db.pool.query(`INSERT INTO marketing_analysis_steps(analysis_id,user_id,step_id,attempt,input_hash,model,images,reserved_cost)
    VALUES($1,$2,'summary:1',1,'hash','fixture',0,0)`, [unverifiedAnalysis, owner]);
  assert.equal((await (await app.request("/marketing/usage")).json() as { analysisBytes: number }).analysisBytes, usageBefore.analysisBytes + 10);
  const deleted = await app.request(`/marketing/${doomed.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual(await deleted.json(), { ok: true, removedBytes: generatedBytes, keptAnalyses: 1 });
  assert.equal(await store.get(owner, doomed.id), null);
  assert.equal((await db.pool.query("SELECT 1 FROM assets WHERE id=ANY($1::uuid[])", [generated.map(row => row.id)])).rowCount, 0);
  for (const row of generated) await assert.rejects(readFile(join(root, "assets", row.storage_key)), { code: "ENOENT" });
  const analysisRows = (await db.pool.query("SELECT id, deleted_at, snapshot FROM marketing_reference_analyses WHERE id=ANY($1::uuid[])", [[doomedAnalysis, unverifiedAnalysis]])).rows;
  const removedRow = analysisRows.find(row => row.id === doomedAnalysis), keptRow = analysisRows.find(row => row.id === unverifiedAnalysis);
  assert.notEqual(removedRow.deleted_at, null); assert.deepEqual(removedRow.snapshot, {});
  assert.equal(keptRow.deleted_at, null);
  assert.deepEqual(await readdir(await analysisStorage.directory(owner, doomedAnalysis)), [], "the deleted analysis folder is removed");
  const usageAfter = await (await app.request("/marketing/usage")).json() as { videoBytes: number };
  assert.equal(usageAfter.videoBytes, usageBefore.videoBytes - generatedBytes);

  // Real adapter -> real worker -> real task.error -> real HTTP project view.
  // The only network surface is a synthetic fetch fixture, never a vendor.
  const originalFetch = globalThis.fetch, originalLog = console.log;
  const sentinel = "SENTINEL-private-prompt https://private.example/a?material_token=SENTINEL-token Bearer SENTINEL-key";
  const diagnostics: string[] = [];
  try {
    console.log = (...values) => { diagnostics.push(JSON.stringify(values)); };
    globalThis.fetch = async (_url, init) => init?.method === "POST"
      ? Response.json({ id: randomUUID(), status: "queued" })
      : Response.json({ status: "failed", error: sentinel, request_id: sentinel });
    const provider = new HttpVideoGenerationProvider({ baseUrl: "https://fixture.invalid", apiKey: "SENTINEL-key", model: "fixture", adapter: new OpenaiVideoAdapter() });
    deps.generation = async (job, signal) => ({ ...await originalGeneration(job, signal), provider });
    const protectedProject = await newProject();
    await assert.rejects(run(protectedProject.taskId), /TASK_FAILED/);
    const storedErrors = (await db.pool.query("SELECT error FROM tasks WHERE id=$1 OR input->>'parentId'=$1::text", [protectedProject.taskId])).rows;
    const visible = await app.request(`/marketing/${protectedProject.p.id}`);
    assert.equal(visible.status, 200);
    const polled = await app.request(`/marketing/${protectedProject.p.id}/status`);
    const polledText = await polled.text();
    assert.equal(JSON.parse(polledText).errorCode, "GENERATION_FAILED");
    assert(!/SENTINEL|private\.example|material_token|Bearer/.test(JSON.stringify(storedErrors) + await visible.text() + polledText + diagnostics.join("\n")));
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; deps.generation = originalGeneration; }
  const maximumShots = Array.from({ length: 15 }, () => ({ ...timedShots[0], durationSec: 4 }));
  let maximum = await store.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ durationSec: 60, storyboard: maximumShots, script: storyboardScript(maximumShots) }));
  maximum = await store.setReview(owner, maximum, { verdict: "pass", issues: [] });
  await store.reserve(owner, maximum.id, maximum.version, { modelId: KLING_MARKETING_PROFILE.modelId }, false);
  const maximumSegments = await store.segments(owner, maximum.id);
  assert.equal(maximumSegments.length, 15); assert.equal(maximumSegments[14].slot, 14);
  await assert.rejects(db.pool.query("INSERT INTO marketing_video_segments(project_id,slot,task_id,script,duration_sec) VALUES($1,15,$2,'invalid',4)", [maximum.id, maximumSegments[0].task_id]), /slot_check/);

  const music = join(root, "music.wav");
  await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "2", music]);
  for (const durationSec of [15, 45, 60] as const) {
    const configured = { ...draft, durationSec, ratio: durationSec === 45 ? "16:9" as const : "1:1" as const, subtitles: true };
    const segments = planMarketingSegments(durationSec === 15 ? script.slice(0, 30) : script, durationSec);
    const assembled = await composeMarketingVideo({ files: segments.map(() => fixture), segments, draft: configured, music });
    assert(Math.abs(assembled.durationSec - durationSec) < 0.3); assert(assembled.body.length > 0);
    assert.equal(assembled.width, durationSec === 45 ? 1280 : 720); assert.equal(assembled.height, 720);
  }
  // F02: the per-owner render cap counts only renders still live in the queue.
  const renders = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of renders.entries()) await db.pool.query("INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,'marketing.video','{}',$2,'lot-marketing-video')", [id, index === 3 ? other : owner]);
  assert.equal(await db.claimTaskWithinOwnerLimit(renders[0], 1, owner, [], 1), "claimed");
  assert.equal(await db.claimTaskWithinOwnerLimit(renders[1], 1, owner, [renders[0]], 1), "busy");
  assert.deepEqual([(await db.getTask(renders[1]))!.status, (await db.getTask(renders[1]))!.stage], ["pending", "排队中：同账号已有视频在制作"]);
  assert.equal(await db.claimTaskWithinOwnerLimit(renders[3], 1, other, [renders[0]], 1), "claimed", "another owner is not blocked");
  assert.equal(await db.claimTaskWithinOwnerLimit(renders[1], 1, owner, [], 1), "claimed", "an orphaned running row does not block");
  assert.equal(await db.claimTaskWithinOwnerLimit(renders[2], 1, owner, [renders[0], renders[1]], 2), "busy");
  await db.cancelTask(renders[2]);
  assert.equal(await db.claimTaskWithinOwnerLimit(renders[2], 1, owner, [], 2), "stopped");
  // F03: a parent render can own a shared voice checkpoint; the claim stays single-writer.
  const voices = new PgKlingVoiceStore(db.pool);
  const voiceScope = { taskId: renders[0], userId: owner, slot: 0, fingerprint: "fixture" };
  const firstVoice = await voices.claim(voiceScope, randomUUID());
  const secondVoice = await voices.claim(voiceScope, randomUUID());
  assert.deepEqual([firstVoice.created, secondVoice.created, secondVoice.checkpoint.externalTaskId], [true, false, firstVoice.checkpoint.externalTaskId]);
  await assert.rejects(voices.get({ ...voiceScope, userId: other }));

  // F06: exact cursor paging (including equal timestamps) and literal search wildcards.
  const pager = randomUUID();
  await db.pool.query("INSERT INTO users(id,name) VALUES($1,'pager fixture')", [pager]);
  const pagedIds: string[] = [];
  for (const topic of ["分页 A", "分页 B", "分页 C", "100%_特价", "分页 D"]) pagedIds.push((await store.save(pager, randomUUID(), 0, MarketingDraftSchema.parse({ ...draft, topic }))).id);
  await db.pool.query("UPDATE marketing_video_projects SET updated_at='2026-10-20 10:00:00.123456+00' WHERE id=ANY($1::uuid[])", [pagedIds.slice(0, 3)]);
  const seen: string[] = [];
  for (let cursor: string | undefined, guard = 0; guard < 10; guard++) {
    const page = await store.page(pager, { limit: 2, cursor });
    assert.ok(page.data.length <= 2);
    seen.push(...page.data.map(p => p.id));
    if (!(cursor = page.nextCursor)) break;
  }
  assert.deepEqual([...seen].sort(), [...pagedIds].sort(), "every draft appears exactly once");
  assert.deepEqual((await store.page(pager, { query: "100%_" })).data.map(p => p.draft.topic), ["100%_特价"]);
  assert.equal((await store.page(pager, { query: "分页_" })).data.length, 0, "_ is literal");
  assert.equal((await store.page(owner, { query: "分页" })).data.length, 0, "search is owner-scoped");

  // F04: review and publication receipts; F07: per-owner in-flight cap.
  const operations = new PgMarketingTextOperations(db.pool);
  const reviewed = await store.save(pager, randomUUID(), 0, draft);
  const reviewId = randomUUID();
  assert.equal((await operations.begin(pager, reviewId, reviewed.id, reviewed.version, "review", { version: reviewed.version, locale: "zh" })).fresh, true);
  await operations.receipt(pager, reviewId, { text: JSON.stringify({ verdict: "pass", issues: [] }), outcome: "completed", usage: { promptTokens: 1, completionTokens: 1 } });
  // A lost response is recovered from the saved receipt, with no second model call.
  assert.equal((await operations.recover(pager, reviewed.id, reviewId)).status, "succeeded");
  const afterReview = (await store.get(pager, reviewed.id))!;
  assert.ok(afterReview.review);
  assert.deepEqual([afterReview.version, afterReview.reviewedScript], [reviewed.version, reviewText(draft)]);
  const replayed = await operations.begin(pager, reviewId, reviewed.id, reviewed.version, "review", { version: reviewed.version, locale: "zh" });
  assert.deepEqual([replayed.fresh, replayed.operation.status], [false, "succeeded"]);
  await assert.rejects(operations.begin(pager, reviewId, reviewed.id, reviewed.version, "review", { version: reviewed.version, locale: "en" }), { status: 409 });
  // A stale review does not overwrite a newer draft.
  const staleId = randomUUID();
  await operations.begin(pager, staleId, reviewed.id, reviewed.version, "review", { version: reviewed.version, locale: "en" });
  await store.save(pager, reviewed.id, reviewed.version, MarketingDraftSchema.parse({ ...draft, topic: "已修改" }));
  assert.equal((await operations.finish(pager, staleId, { review: { verdict: "pass", issues: [] } })).status, "conflict");
  // Titles stay editable after a video job exists; copy does not.
  const { p: submitted } = await newProject();
  const titleId = randomUUID();
  await operations.begin(owner, titleId, submitted.id, submitted.version, "publication", { version: submitted.version, locale: "zh", fillMissing: false });
  const titled = await operations.finish(owner, titleId, { draft: MarketingDraftSchema.parse({ ...submitted.draft, publishTitle: "新标题" }), analysis: "" });
  assert.equal(titled.status, "succeeded");
  assert.equal((await store.get(owner, submitted.id))!.draft.publishTitle, "新标题");
  await assert.rejects(operations.begin(owner, randomUUID(), submitted.id, submitted.version + 1, "copy", {}), { status: 409 });
  const busy = await Promise.all([0, 1, 2].map(() => store.save(pager, randomUUID(), 0, draft)));
  const running = [randomUUID(), randomUUID()];
  for (const [index, id] of running.entries()) await operations.begin(pager, id, busy[index].id, busy[index].version, "storyboard", { version: busy[index].version });
  await assert.rejects(operations.begin(pager, randomUUID(), busy[2].id, busy[2].version, "storyboard", { version: busy[2].version }), { status: 429 });
  await operations.fail(pager, running[0], false);
  assert.equal((await operations.begin(pager, randomUUID(), busy[2].id, busy[2].version, "storyboard", { version: busy[2].version })).fresh, true);
  // R1: twin narration takes on PG, a version 4 job composed from them, and cleanup with the draft.
  const twin = randomUUID(), silentTake = join(root, "take.wav");
  await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=24000", "-t", "3", silentTake]);
  let speeches = 0;
  const narrator = new MarketingNarrator(db.pool, root, {
    ready: async (_owner: string, itemId: string) => { assert.equal(itemId, twin); return { targetModel: "qwen-audio-3.0-tts-plus", voiceId: "fixture-voice" }; },
    speakAs: async () => { speeches++; await new Promise(done => setTimeout(done, 50)); return { audio: await readFile(silentTake), mime: "audio/wav" }; },
  } as never);
  let narrated = await store.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ ...draft, narration: { twinItemId: twin } }));
  narrated = await store.setReview(owner, narrated, { verdict: "pass", issues: [] });
  const shots = resolveMarketingSegments(narrated.draft, KLING_MARKETING_PROFILE);
  await assert.rejects(narrator.frozen(owner, narrated.id, narrated.draft, shots), /请先生成全部分镜/);
  const [takesA, takesB] = await Promise.all([0, 1].map(() => narrator.synthesize(owner, narrated.id, narrated.draft, shots)));
  assert.equal(speeches, shots.length, "concurrent requests pay for each shot once");
  assert(takesA.clips.concat(takesB.clips).every(clip => clip.status === "succeeded" || clip.status === "running"));
  assert.deepEqual((await narrator.status(owner, narrated.id, narrated.draft, shots)).map(clip => [clip.status, Math.round((clip.durationMs ?? 0) / 100)]), shots.map(() => ["succeeded", 30]));
  assert.deepEqual((await narrator.status(other, narrated.id, narrated.draft, shots)).map(clip => clip.status), shots.map(() => "missing"), "takes are owner-scoped");
  await narrator.synthesize(owner, narrated.id, narrated.draft, shots, [1]);
  assert.equal(speeches, shots.length + 1, "only the chosen shot is redone");
  const takes = await narrator.frozen(owner, narrated.id, narrated.draft, shots);
  const narratedTask = await store.reserve(owner, narrated.id, narrated.version, { modelId: KLING_MARKETING_PROFILE.modelId, marketingInputVersion: 4, generate_audio: false, narration: takes }, false);
  const narratedOutput = await run(narratedTask);
  const narratedFile = join(root, "assets", (await db.getAsset(narratedOutput.assetIds[0]))!.storage_key);
  assert(Math.abs((await inspectMedia(narratedFile)).duration - 30) < 0.3);
  // The fixture clips carry a 440 Hz tone; only the silent takes may be heard.
  assert.match(spawnSync(ffmpeg(), ["-v", "info", "-i", narratedFile, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr, /max_volume: -(9\d|inf)/);
  // A narrated video keeps the picture of a reworded shot and of new voice settings: only takes are paid.
  const recomposeNarrated = async (change: (value: MarketingDraft) => MarketingDraft, base: string) => {
    let p = (await store.get(owner, narrated.id))!;
    p = await store.save(owner, p.id, p.version, change(p.draft));
    p = await store.setReview(owner, p, { verdict: "pass", issues: [] });
    const plan = resolveMarketingSegments(p.draft, KLING_MARKETING_PROFILE);
    await narrator.synthesize(owner, p.id, p.draft, plan);
    const job = await store.revise(owner, p.id, p.version, base, [], { narration: await narrator.frozen(owner, p.id, p.draft, plan) });
    await run(job);
    return job;
  };
  const clipsBefore = creates, speechesBefore = speeches;
  const reworded = await recomposeNarrated(value => {
    const storyboard = value.storyboard.map((shot, i) => i === 1 ? { ...shot, script: "欢迎来店里坐一坐，挑一杯喜欢的咖啡。" } : shot);
    return { ...value, storyboard, script: storyboardScript(storyboard) };
  }, narratedTask);
  assert.equal(creates, clipsBefore, "a reworded narrated shot keeps its clip");
  assert.equal(speeches, speechesBefore + 1, "only the reworded shot gets a new take");
  assert.equal((await store.segments(owner, narrated.id))[1].script, "欢迎来店里坐一坐，挑一杯喜欢的咖啡。");
  await recomposeNarrated(value => ({ ...value, narration: { ...value.narration!, speed: 1.1 } }), reworded);
  assert.equal(creates, clipsBefore, "new voice settings keep every clip");
  assert.equal(speeches, speechesBefore + 1 + shots.length, "new voice settings need every take again");
  const picture = (await store.get(owner, narrated.id))!;
  await store.save(owner, picture.id, picture.version, { ...picture.draft, storyboard: picture.draft.storyboard.map((shot, i) => i ? { ...shot, camera: "推近" } : shot) });
  const changedPicture = (await store.setReview(owner, (await store.get(owner, narrated.id))!, { verdict: "pass", issues: [] }));
  await assert.rejects(store.revise(owner, narrated.id, changedPicture.version, changedPicture.taskId!, []), /重新选择/, "a changed picture is never kept");
  await store.remove(owner, narrated.id); await narrator.removeFiles(narrated.id);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM marketing_video_narrations WHERE project_id=$1", [narrated.id])).rows[0].n, 0);
  await assert.rejects(readdir(join(root, "marketing-narration", narrated.id)));
  // P01: key-art stills on PG: one paid image per look even when asked twice at once,
  // owner-scoped, a new look needs a new still, and the images go with the draft.
  await mkdir(join(root, "uploads"), { recursive: true });
  const stillBytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(stillBytes);
  stillBytes.write("IHDR", 12, "ascii"); stillBytes.writeUInt32BE(1024, 16); stillBytes.writeUInt32BE(1536, 20);
  let images = 0;
  const artist = new MarketingKeyArtist(db.pool, root, {
    provider: async () => ({
      create: async () => { images++; await new Promise(done => setTimeout(done, 100)); return { taskId: "still", status: "completed", progress: 100 }; },
      poll: async () => ({ status: "completed", progress: 100, urls: [`data:image/png;base64,${stillBytes.toString("base64")}`] }),
    }),
    getAsset: id => db.getAsset(id) as never, createAsset: asset => db.createAsset(asset),
    storage: { put: async ({ key, body }) => { await writeFile(join(root, "uploads", key), body); return { url: `/static/uploads/${key}` }; } },
    sign: asset => `${asset.url}?material_token=fixture`,
  });
  const looked = await store.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ ...draft, continuity: "短发女店员，米色针织衫，木质吧台" }));
  await Promise.all([0, 1].map(() => artist.generate(owner, looked.id, looked.draft, KLING_MARKETING_PROFILE, false)));
  assert.equal(images, 1, "concurrent requests pay for one still");
  assert.equal((await artist.status(owner, looked.id, looked.draft)).status, "succeeded");
  assert.equal((await artist.status(other, looked.id, looked.draft)).status, "missing", "stills are owner-scoped");
  assert.equal((await artist.status(owner, looked.id, { ...looked.draft, continuity: "长发" })).status, "missing", "a new look needs a new still");
  await artist.generate(owner, looked.id, looked.draft, KLING_MARKETING_PROFILE, true);
  assert.equal(images, 2, "only an explicit redo pays again");
  const still = await artist.frozen(owner, looked.id, looked.draft, KLING_MARKETING_PROFILE);
  assert(still && still.user_id === owner && still.type === "upload" && (still as { is_private?: boolean }).is_private);
  assert((await store.usage(owner)).materialBytes >= 66, "stills count as draft materials");
  const removedStills = await store.remove(owner, looked.id);
  assert.equal(removedStills.keyArtFiles.length, 2);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM marketing_video_key_arts WHERE project_id=$1", [looked.id])).rows[0].n, 0);
  assert.equal(await db.getAsset(still.id), null);
  console.log(JSON.stringify({ migrations: "upgrade and repeated startup passed", keyArt: "one paid still per look under concurrency, owner-scoped, redo only on request, removed with the draft", twinNarration: "takes paid once per shot, owner-scoped, v4 job composed from them, removed with the draft", ownerRenderCap: "live entries only, owner-scoped", parentVoice: "single claim per parent and slot", draftPaging: "exact cursor, literal search", recordedReview: "receipt recovery, replay, conflict", publicationAfterJob: "allowed", textInflightCap: "429 at 2", ownership: "passed", reviewVersioning: "passed", atomicReservation: "passed", segmentRetry: "passed", unknownSubmission: "no replay", unknownRelease: "owner-scoped, audited, unfinished clips only; text intents released without late apply", shotRedo: "only chosen shots submitted and billed, kept clips reused, composition-only and narrated rewording/voice changes recomposed without clips, earlier jobs removed with the draft", cancellation: "passed", downloadResume: "passed", legacyWebmHttpRecovery: "202, original IDs and input, no new POST", safeErrors: "adapter, task.error, HTTP view and logs passed", billingDedup: "passed", archiveUpdateAndRecreate: "passed", oversizedPlan: "70s rejected with zero provider calls", compositionSeconds: [15, 17, 30, 45, 60, 65], maximumShots: 15, bgm: "passed", modelCaptions: "prompt-controlled; visual quality requires real model verification", creates, polls }, null, 2));
} finally { await db.close(); await rm(root, { recursive: true, force: true }); }
