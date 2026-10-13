/** Opt-in integration check. Use a NEW, empty, disposable local database. No paid model calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketingDraftSchema, planMarketingSegments } from "@lot-agent/core/marketing-video";
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
const draft = MarketingDraftSchema.parse({ topic: "咖啡店", script, publishTitle: "欢迎来喝咖啡", tags: "#咖啡 #探店", subtitles: false });
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
  await runMigrations(db.pool, migrations); await runMigrations(db.pool, migrations);
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

  const music = join(root, "music.wav");
  await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "2", music]);
  for (const durationSec of [45, 60] as const) {
    const configured = { ...draft, durationSec, ratio: durationSec === 45 ? "16:9" as const : "1:1" as const, subtitles: true };
    const segments = planMarketingSegments(script, durationSec);
    const assembled = await composeMarketingVideo({ files: segments.map(() => fixture), segments, draft: configured, music });
    assert(Math.abs(assembled.durationSec - durationSec) < 0.3); assert(assembled.body.length > 0);
    assert.equal(assembled.width, durationSec === 45 ? 1280 : 720); assert.equal(assembled.height, 720);
  }
  console.log(JSON.stringify({ migrations: "upgrade and repeated startup passed", ownership: "passed", reviewVersioning: "passed", atomicReservation: "passed", segmentRetry: "passed", unknownSubmission: "no replay", cancellation: "passed", downloadResume: "passed", billingDedup: "passed", archiveUpdateAndRecreate: "passed", compositionSeconds: [30, 45, 60], bgm: "passed", modelCaptions: "prompt-controlled; visual quality requires real model verification", creates, polls }, null, 2));
} finally { await db.close(); await rm(root, { recursive: true, force: true }); }
