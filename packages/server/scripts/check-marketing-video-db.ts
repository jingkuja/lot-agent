/** Opt-in integration check. Use a NEW, empty, disposable local database. No paid model calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketingDraftSchema, planMarketingSegments, storyboardScript } from "@lot-agent/core/marketing-video";
import { DB } from "../src/db/database.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { migrations } from "../src/db/migrations/index.js";
import { PgMarketingProjectStore } from "../src/marketing-video/repository.js";
import { runMarketingVideo, type MarketingRunDeps } from "../src/marketing-video/run.js";
import { archiveMarketingVideo } from "../src/marketing-video/archive.js";
import { composeMarketingVideo, ffmpeg, inspectMedia, mediaCapabilities, mediaProcess } from "../src/marketing-video/media.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { UsageMeter } from "../src/billing/meter.js";

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
  const taskId = await store.reserve(owner, p.id, p.version, { modelId: "fixture" }, false);
  return { p: (await store.get(owner, p.id))!, taskId };
}
async function run(taskId: string) {
  await db.markTaskRunning(taskId, 1);
  const row = (await db.getTask(taskId))!;
  try {
    const output = await runMarketingVideo(deps, { id: taskId, userId: row.user_id, input: row.input as Record<string, unknown> }, new AbortController().signal);
    await db.setTaskResult(taskId, output); return output;
  } catch (error) { await db.setTaskError(taskId, (error as Error).message); throw error; }
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
  const before = creates;
  await store.reserve(owner, two.p.id, two.p.version, {}, true);
  await assert.rejects(run(two.taskId), /结果未知/); assert.equal(creates, before);

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
    const timedTask = await store.reserve(owner, timed.id, timed.version, { modelId: "fixture" }, false);
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
  await assert.rejects(store.reserve(owner, oversized.id, oversized.version, { modelId: "fixture" }, false), /分镜总时长/);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n, tasksBefore);
  assert.equal((await store.get(owner, oversized.id))!.taskId, null);
  // Even corrupted persisted durations are rejected before provider resolution.
  const validShots = oversizedShots.map(s => ({ ...s, durationSec: 13 }));
  let corrupted = await store.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ durationSec: 60, storyboard: validShots, script: storyboardScript(validShots) }));
  corrupted = await store.setReview(owner, corrupted, { verdict: "pass", issues: [] });
  const corruptTask = await store.reserve(owner, corrupted.id, corrupted.version, { modelId: "fixture" }, false);
  await db.pool.query("UPDATE marketing_video_segments SET duration_sec=14 WHERE project_id=$1", [corrupted.id]);
  let resolved = 0; const originalGeneration = deps.generation;
  deps.generation = async () => { resolved++; throw new Error("must not resolve provider for oversized video"); };
  await assert.rejects(run(corruptTask), /视频分段配置不完整/);
  assert.equal(resolved, 0);
  deps.generation = originalGeneration;
  // Upgrade an already submitted pre-v2 WebM job. Its frozen audio options
  // and narration survive current reference-video restrictions and retries.
  let oldVideo = await store.save(owner, randomUUID(), 0, { ...draft, assets: { video: randomUUID(), voice: randomUUID() } });
  oldVideo = await store.setReview(owner, oldVideo, { verdict: "pass", issues: [] });
  const oldVideoTask = await store.reserve(owner, oldVideo.id, oldVideo.version, { modelId: "fixture", generate_audio: true, reference_video: ["https://fixture.invalid/legacy.webm"], reference_audio: ["https://fixture.invalid/voice.wav"] }, false);
  const capturedInputs: Record<string, unknown>[] = [];
  deps.generation = async (job, signal) => { capturedInputs.push(job.input); return originalGeneration(job, signal); };
  await run(oldVideoTask);
  assert(capturedInputs.length > 1);
  for (const input of capturedInputs) {
    assert.equal(input.generate_audio, true);
    assert.deepEqual(input.reference_audio, ["https://fixture.invalid/voice.wav"]);
  }
  const oldSent = creates;
  await store.reserve(owner, oldVideo.id, oldVideo.version, {}, true);
  await run(oldVideoTask); assert.equal(creates, oldSent);
  deps.generation = originalGeneration;
  const maximumShots = Array.from({ length: 15 }, () => ({ ...timedShots[0], durationSec: 4 }));
  let maximum = await store.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ durationSec: 60, storyboard: maximumShots, script: storyboardScript(maximumShots) }));
  maximum = await store.setReview(owner, maximum, { verdict: "pass", issues: [] });
  await store.reserve(owner, maximum.id, maximum.version, { modelId: "fixture" }, false);
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
  console.log(JSON.stringify({ migrations: "upgrade and repeated startup passed", ownership: "passed", reviewVersioning: "passed", atomicReservation: "passed", segmentRetry: "passed", unknownSubmission: "no replay", cancellation: "passed", downloadResume: "passed", billingDedup: "passed", archiveUpdateAndRecreate: "passed", oversizedPlan: "70s rejected with zero provider calls", compositionSeconds: [15, 17, 30, 45, 60, 65], maximumShots: 15, bgm: "passed", modelCaptions: "prompt-controlled; visual quality requires real model verification", creates, polls }, null, 2));
} finally { await db.close(); await rm(root, { recursive: true, force: true }); }
