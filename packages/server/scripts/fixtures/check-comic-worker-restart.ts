import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import { buildComicGenerationInput } from "@lot-agent/core/comic-drama";
import type { DB } from "../../src/db/database.js";
import { BullmqJobQueue } from "../../src/jobs/bullmq-queue.js";
import { createRedisConnection } from "../../src/jobs/redis.js";
import { COMIC_VIDEO_TASK } from "../../src/jobs/task-queues.js";
import { ffmpeg, mediaProcess } from "../../src/marketing-video/media.js";
import { PgComicGeneration } from "../../src/comic-drama/generation-repository.js";
import { PgComicDramaRepository } from "../../src/comic-drama/repository.js";
import { PgComicLibrary } from "../../src/comic-drama/library-repository.js";
import { ComicMediaLibrary } from "../../src/comic-drama/media-library.js";
import { runComicVideoGeneration } from "../../src/comic-drama/video-worker.js";
import { PgComicVideo } from "../../src/comic-drama/video-repository.js";

const model = "doubao-seedance-2-0";
const vendorId = "w7-fixture-paid-once";
const mediaFor = (db: DB, root: string) => new ComicMediaLibrary(root, new PgComicLibrary(db.pool), { masterKey: "cd".repeat(32) });
const jobLimits = { concurrency: 2, perUser: 1, segments: 2 };

export function startComicCrashWorker(db: DB, redis: ReturnType<typeof createRedisConnection>, root: string) {
  const queue = new BullmqJobQueue(db, redis, jobLimits);
  queue.process(COMIC_VIDEO_TASK, (job, control) => runComicVideoGeneration({
    pool: db.pool, media: mediaFor(db, root),
    checkCredits: async () => null,
    provider: async () => ({
      async create() {
        process.send?.("create");
        return { taskId: vendorId, status: "queued", progress: 0 };
      },
      async poll(id, options) {
        assert.equal(id, vendorId);
        process.send?.("poll");
        await delay(120_000, undefined, { signal: options?.signal });
        throw new Error("Crash fixture cancelled");
      },
    }),
    download: async () => assert.fail("The initial worker must be killed before downloading"),
  }, job, control.signal));
  process.send?.("ready");
}

export async function checkComicWorkerRestart(db: DB, redis: string, publisher: BullmqJobQueue, spawn: (root: string) => ChildProcess) {
  const root = await mkdtemp(join(tmpdir(), "lot-w7-worker-"));
  let child: ChildProcess | undefined;
  let replacement: BullmqJobQueue | undefined;
  try {
    const path = join(root, "replacement.mp4");
    await mediaProcess(ffmpeg(), ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x568:r=24:d=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", path], { timeoutMs: 15_000 });
    const body = await readFile(path);
    const owner = randomUUID();
    await db.pool.query("INSERT INTO users(id,name) VALUES($1,'comic restart fixture')", [owner]);
    const seriesRepo = new PgComicDramaRepository(db.pool);
    const { series } = await seriesRepo.create(owner, { title: "W7 worker restart", logline: "", seriesGroup: null, episodeNo: null,
      aspectRatio: "9:16", styleKey: "webtoon", videoModel: model });
    const { clips: [blank] } = await seriesRepo.addClip(owner, series.id, series.revision);
    const { clip, seriesRevision } = await seriesRepo.saveClip(owner, series.id, blank.id, {
      expectedRevision: blank.revision, draft: { ...blank.draft, durationMs: 4000,
        shots: [{ id: randomUUID(), description: "A lamp sways.", framingKey: "medium", movementKey: "fixed", durationShare: 100 }] },
    });
    const frozen = buildComicGenerationInput({ series: { ...series, revision: seriesRevision }, clip, cast: [], mode: "references", modelId: model });
    assert(frozen.ok);
    const gen = new PgComicGeneration(db.pool);
    const scope = { kind: "series", id: series.id } as const;
    const price = { modelId: model, unit: "second", amountMicros: 500_000 } as const;
    const { confirmationId } = await gen.quote(owner, scope, String(seriesRevision), price, [frozen.input], []);
    assert(confirmationId);
    const { taskId, type } = await gen.confirm(owner, scope, confirmationId, async () => price, async inputs => {
      assert.deepEqual(inputs, [frozen.input]);
    });
    const request = () => gen.status(owner, confirmationId);
    const { id: takeId } = (await request()).takes[0];
    const events: string[] = [];
    child = spawn(root);
    child.on("message", message => { if (typeof message === "string") events.push(message); });
    await until(() => events.includes("ready"), 10_000, "first worker ready");
    await publisher.publishNewTask(taskId, type);
    await until(() => events.includes("poll"), 10_000, "first worker received vendor ID");
    const video = new PgComicVideo(db.pool);
    assert.equal((await video.receipt(owner, takeId)).vendorId, vendorId);
    assert.deepEqual(events, ["ready", "create", "poll"]);
    const exit = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    const [, signal] = await exit;
    assert.equal(signal, "SIGKILL");
    assert.equal((await request()).takes[0].state, "running");
    const restart = Date.now();
    replacement = new BullmqJobQueue(db, createRedisConnection(redis), jobLimits);
    let createCount = 0;
    const polled: string[] = [];
    replacement.process(COMIC_VIDEO_TASK, (job, control) => runComicVideoGeneration({
      pool: db.pool, media: mediaFor(db, root),
      checkCredits: async () => assert.fail("a submitted video must not need a new credit check"),
      provider: async () => ({
        async create() { createCount++; return assert.fail("replacement must reuse the persisted vendor ID"); },
        async poll(id) {
          polled.push(id);
          return { status: "completed", progress: 100, url: "https://fixture.invalid/w7.mp4" };
        },
      }),
      download: async (_url, _options, consume) => consume({ body: new Response(new Uint8Array(body)).body, mime: "video/mp4" }),
    }, job, control.signal));
    await until(async () => !(await request()).active, 75_000, "replacement completes the stalled BullMQ job");
    const result = await request();
    assert.equal(result.taskId, taskId);
    assert.equal(result.takes[0].id, takeId);
    assert.equal(result.takes[0].state, "ready");
    assert.ok(result.takes[0].mediaId);
    assert.equal(createCount, 0);
    assert.deepEqual(polled, [vendorId]);
    console.log("W7_WORKER_RESTART", JSON.stringify({ waitMs: Date.now() - restart, originalSubmits: 1, replacementSubmits: 0, ready: 1 }));
  } finally {
    if (child?.exitCode === null && !child.signalCode) {
      const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
    }
    await replacement?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function until(check: () => boolean | Promise<boolean>, timeout: number, reason: string) {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > end) throw new Error(reason);
    await delay(100);
  }
}
