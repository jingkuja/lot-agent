/** Opt-in, no-model integration check. Requires disposable local PG and Redis DB 15. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Queue, Worker } from "bullmq";
import { DB } from "../src/db/database.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { migrations } from "../src/db/migrations/index.js";
import { BullmqJobQueue } from "../src/jobs/bullmq-queue.js";
import { createRedisConnection } from "../src/jobs/redis.js";
import { DEFAULT_TASK_QUEUE, MARKETING_VIDEO_QUEUE } from "../src/jobs/task-queues.js";

const pgRaw = process.env.MARKETING_QUEUE_CHECK_DATABASE_URL;
const redisRaw = process.env.MARKETING_QUEUE_CHECK_REDIS_URL;
if (!pgRaw || !redisRaw) throw new Error("Set MARKETING_QUEUE_CHECK_DATABASE_URL and MARKETING_QUEUE_CHECK_REDIS_URL to disposable local services");
const pgUrl = new URL(pgRaw), redisUrl = new URL(redisRaw);
const local = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
if (!local(pgUrl.hostname) || !/^\/marketing_check_[a-z0-9_]+$/.test(pgUrl.pathname)) throw new Error("Only an isolated local marketing_check_* database is allowed");
if (!local(redisUrl.hostname) || redisUrl.pathname !== "/15") throw new Error("Only an isolated local Redis DB 15 is allowed");
const db = new DB({ host: pgUrl.hostname, port: Number(pgUrl.port || 5432), user: decodeURIComponent(pgUrl.username), password: decodeURIComponent(pgUrl.password), database: pgUrl.pathname.slice(1) });
const publisherConnection = createRedisConnection(redisRaw);
// A separate OS process proves that cancellation does not depend on the API's
// in-memory AbortController. This child only runs the synthetic fixture type.
if (process.argv.includes("--cancellation-worker")) {
  const queue = new BullmqJobQueue(db, publisherConnection);
  queue.process("fixture.cross-process", async (job, ctl) => {
    process.send?.({ event: "started", id: job.id });
    await new Promise<void>(done => {
      if (ctl.signal.aborted) done();
      else ctl.signal.addEventListener("abort", () => done(), { once: true });
    });
    process.send?.({ event: "stopped", id: job.id });
    return { shouldNotOverwriteCancellation: true };
  });
  process.on("message", message => {
    if (message === "close") void queue.close().then(() => db.close()).then(() => process.exit(0));
  });
  process.send?.({ event: "ready" });
} else {
let publisher: BullmqJobQueue | undefined, consumer: BullmqJobQueue | undefined;
let child: ChildProcess | undefined;
let legacyQueue: Queue | undefined, marketingQueue: Queue | undefined, legacyWorker: Worker | undefined;
const releaseLegacy = deferred(), releaseMarketing = deferred();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(done => setTimeout(done, 20));
  }
}
try {
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0, "Refusing a nonempty database");
  assert.equal(await publisherConnection.dbsize(), 0, "Refusing a nonempty Redis DB");
  await db.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await runMigrations(db.pool, migrations.filter(m => m.version < 46));
  const owner = randomUUID();
  await db.pool.query("INSERT INTO users(id,name) VALUES($1,'queue fixture')", [owner]);
  const activeId = randomUUID();
  const legacyInput = { kind: "legacy-active", frozen: "original-input" };
  await db.createTask(activeId, "marketing.video", legacyInput, owner);
  await db.setTaskVendorId(activeId, "fixture-original-vendor-receipt");
  const untouched = [randomUUID(), randomUUID(), randomUUID()];
  await db.createTask(untouched[0], "image.generate", { keep: "ordinary" }, owner);
  await db.createTask(untouched[1], "marketing.segment", { keep: "segment" }, owner, "marketing-segments");
  await db.createTask(untouched[2], "marketing.video", { keep: "custom-queue" }, owner, "custom-queue");
  const beforeMigration = (await db.pool.query("SELECT * FROM tasks ORDER BY id")).rows;
  await db.migrate(); await db.migrate();
  const afterMigration = (await db.pool.query("SELECT * FROM tasks ORDER BY id")).rows;
  assert.deepEqual(afterMigration, beforeMigration.map(row => row.id === activeId ? { ...row, queue_name: MARKETING_VIDEO_QUEUE } : row), "0046 changes only marketing parent queue metadata; restart is idempotent");
  const migrated = (await db.pool.query("SELECT * FROM tasks WHERE id=$1", [activeId])).rows[0];
  assert.equal(migrated.queue_name, MARKETING_VIDEO_QUEUE);
  assert.deepEqual(migrated.input, legacyInput);
  assert.equal(migrated.vendor_task_id, "fixture-original-vendor-receipt");
  publisher = new BullmqJobQueue(db, publisherConnection);
  legacyQueue = new Queue(DEFAULT_TASK_QUEUE, { connection: publisherConnection });
  marketingQueue = new Queue(MARKETING_VIDEO_QUEUE, { connection: publisherConnection });

  // Simulate an old deployment that still owns an active legacy queue lock.
  await legacyQueue.add("marketing.video", { taskId: activeId }, { jobId: activeId, attempts: 1 });
  legacyWorker = new Worker(DEFAULT_TASK_QUEUE, async job => {
    await db.markTaskRunning(job.data.taskId, 1);
    await releaseLegacy.promise;
    await db.setTaskResult(job.data.taskId, { originalWorker: true });
  }, { connection: publisherConnection, concurrency: 1 });
  await until(async () => await (await legacyQueue!.getJob(activeId))?.getState() === "active", "legacy worker starts");
  assert.equal(await publisher.canResumePersisted(activeId), false);
  await publisher.deliverPersisted(activeId, "marketing.video");
  assert.equal(await marketingQueue.getJob(activeId), undefined, "active legacy work must not be duplicated");
  releaseLegacy.resolve();
  await until(async () => await (await legacyQueue!.getJob(activeId))?.getState() === "completed", "legacy worker finishes");
  await legacyWorker.close(); legacyWorker = undefined;

  // A waiting legacy entry moves safely with the same DB and Redis task ID.
  const waitingId = randomUUID();
  await db.createTask(waitingId, "marketing.video", { kind: "legacy-waiting" }, owner, MARKETING_VIDEO_QUEUE);
  await legacyQueue.add("marketing.video", { taskId: waitingId }, { jobId: waitingId, attempts: 1 });
  await publisher.deliverPersisted(waitingId, "marketing.video");
  assert.equal(await legacyQueue.getJob(waitingId), undefined);
  assert.equal((await marketingQueue.getJob(waitingId))?.id, waitingId);

  const starts = new Map<string, number>();
  consumer = new BullmqJobQueue(db, createRedisConnection(redisRaw));
  consumer.process<{ kind: string }, unknown>("marketing.video", async job => {
    const count = (starts.get(job.id) ?? 0) + 1; starts.set(job.id, count);
    if (job.input.kind === "blocked") await releaseMarketing.promise;
    if (job.input.kind === "fail-once" && count === 1) throw new Error("fixture definite failure");
    return { originalId: job.id, kind: job.input.kind };
  });
  consumer.process("image.generate", async job => ({ ordinaryId: job.id }));
  await until(async () => await db.getTaskStatus(waitingId) === "succeeded", "migrated waiting task");
  const blockedId = await publisher.enqueue("marketing.video", { kind: "blocked" }, owner, { maxAttempts: 1 });
  await until(async () => starts.has(blockedId), "long marketing task starts");
  const ordinaryId = await publisher.enqueue("image.generate", {}, owner);
  await until(async () => await db.getTaskStatus(ordinaryId) === "succeeded", "ordinary task finishes without releasing marketing task");
  assert.equal(await db.getTaskStatus(blockedId), "running");
  const metadata = await db.pool.query("SELECT id,queue_name FROM tasks WHERE id=ANY($1::uuid[])", [[blockedId, ordinaryId]]);
  assert.equal(metadata.rows.find(row => row.id === blockedId)?.queue_name, MARKETING_VIDEO_QUEUE);
  assert.equal(metadata.rows.find(row => row.id === ordinaryId)?.queue_name, DEFAULT_TASK_QUEUE);

  // The compatibility worker forwards old entries without waiting for the render.
  const bridgeId = randomUUID();
  await db.createTask(bridgeId, "marketing.video", { kind: "legacy-bridge" }, owner, MARKETING_VIDEO_QUEUE);
  await legacyQueue.add("marketing.video", { taskId: bridgeId }, { jobId: bridgeId, attempts: 1 });
  await until(async () => await (await legacyQueue!.getJob(bridgeId))?.getState() === "completed", "legacy forwarding completes");
  assert.equal(await db.getTaskStatus(bridgeId), "pending");
  assert.equal((await marketingQueue.getJob(bridgeId))?.id, bridgeId);
  const cancelledId = await publisher.enqueue("marketing.video", { kind: "cancelled" }, owner);
  // Advance persisted age, keeping the first render blocked and the second
  // in a real Redis waiting list throughout the actual watchdog call.
  await db.pool.query("UPDATE tasks SET created_at=now()-interval '4 minutes' WHERE id=ANY($1::uuid[])", [[bridgeId, cancelledId]]);
  await publisher.diagnosePending(180_000);
  assert.equal(await db.getTaskStatus(bridgeId), "pending");
  assert.equal((await db.getTask(bridgeId))?.stage, "等待队列处理");
  assert.equal(await db.getTaskStatus(cancelledId), "pending");
  assert.equal(await publisher.cancel(cancelledId), true);
  assert.equal(await marketingQueue.getJob(cancelledId), undefined);
  releaseMarketing.resolve();
  await until(async () => await db.getTaskStatus(bridgeId) === "succeeded", "forwarded task completes");
  assert.equal(await db.getTaskStatus(blockedId), "succeeded");
  assert.equal(await db.getTaskStatus(cancelledId), "cancelled");
  assert.equal(starts.has(cancelledId), false);
  assert.equal(starts.get(bridgeId), 1);

  // Delayed entries are healthy, missing delivery is recoverable by original ID.
  const delayedId = await publisher.enqueue("marketing.video", {}, owner, { delayMs: 60_000 });
  const missingId = randomUUID(); await db.createTask(missingId, "marketing.video", {}, owner, MARKETING_VIDEO_QUEUE);
  await db.pool.query("UPDATE tasks SET created_at=now()-interval '4 minutes' WHERE id=ANY($1::uuid[])", [[delayedId, missingId]]);
  await publisher.diagnosePending(180_000);
  assert.equal((await db.getTask(delayedId))?.stage, "等待队列处理");
  assert.equal((await db.getTask(missingId))?.stage, "投递未完成，可恢复排队");
  assert.equal(await db.getTaskStatus(missingId), "pending");
  await publisher.deliverPersisted(missingId, "marketing.video");
  await until(async () => await db.getTaskStatus(missingId) === "succeeded", "same-ID missing delivery recovery");
  await publisher.cancel(delayedId);

  // Failed work is not automatically replayed by a stale legacy queue entry.
  const retryInput = { kind: "fail-once", frozen: { receipt: "fixture-original-receipt" } };
  const retryId = await publisher.enqueue("marketing.video", retryInput, owner, { maxAttempts: 1 });
  await until(async () => await (await marketingQueue!.getJob(retryId))?.getState() === "failed", "failure persisted");
  await legacyQueue.add("marketing.video", { taskId: retryId }, { jobId: retryId, attempts: 1 });
  await until(async () => await (await legacyQueue!.getJob(retryId))?.getState() === "completed", "stale legacy entry skipped");
  assert.equal(starts.get(retryId), 1);
  assert.equal(await publisher.canResumePersisted(retryId), true);
  // Redis redelivery alone cannot resurrect a declared terminal failure.
  await (await marketingQueue.getJob(retryId))!.retry("failed");
  await until(async () => await (await marketingQueue!.getJob(retryId))?.getState() === "completed", "terminal redelivery skipped");
  assert.equal(starts.get(retryId), 1); assert.equal(await db.getTaskStatus(retryId), "failed");
  await db.updateTaskStatus(retryId, "pending");
  await publisher.deliverPersisted(retryId, "marketing.video");
  await until(async () => await db.getTaskStatus(retryId) === "succeeded", "explicit same-ID resume");
  assert.equal(starts.get(retryId), 2);
  assert.deepEqual((await db.getTask(retryId))?.input, retryInput);
  assert.deepEqual((await db.getTask(retryId))?.output, { originalId: retryId, kind: "fail-once" });

  let retryStarts = 0;
  consumer.process("fixture.retry", async () => { if (++retryStarts === 1) throw new Error("temporary fixture error"); return { attempts: retryStarts }; });
  const automaticId = await publisher.enqueue("fixture.retry", {}, owner, { maxAttempts: 2 });
  await until(async () => await db.getTaskStatus(automaticId) === "succeeded", "permitted automatic retry");
  assert.equal(retryStarts, 2);
  assert.equal((await db.getTask(automaticId))?.attempts, 2);

  await consumer.close(); consumer = undefined;
  const events = new Set<string>();
  child = fork(fileURLToPath(import.meta.url), ["--cancellation-worker"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  child.on("message", message => events.add((message as { event: string }).event));
  await until(async () => events.has("ready"), "child process ready");
  const crossId = await publisher.enqueue("fixture.cross-process", {}, owner);
  await until(async () => events.has("started"), "child process claimed task");
  assert.equal(await publisher.cancel(crossId), true);
  await until(async () => events.has("stopped"), "child observes durable cancellation");
  assert.equal(await db.getTaskStatus(crossId), "cancelled");
  await until(async () => await publisher!.canResumePersisted(crossId), "child unwinds queue lock");
  assert.equal(await db.getTaskStatus(crossId), "cancelled", "late result cannot undo cancellation");
  console.log("PASS: PG/Redis isolation, 0046 invariants, long pending diagnostics, delayed/missing delivery, terminal guard, automatic retry, same-ID resume and cross-process cancellation; no model calls");
} finally {
  releaseLegacy.resolve(); releaseMarketing.resolve();
  await legacyWorker?.close();
  await consumer?.close();
  await legacyQueue?.close(); await marketingQueue?.close();
  if (publisher) await publisher.close(); else publisherConnection.disconnect();
  if (child && child.exitCode === null) {
    child.send("close");
    await new Promise<void>(resolve => { const timeout = setTimeout(() => { child?.kill(); resolve(); }, 5000); child!.once("exit", () => { clearTimeout(timeout); resolve(); }); });
  }
  await db.close();
}
}
