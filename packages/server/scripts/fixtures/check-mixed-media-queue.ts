import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DB } from "../../src/db/database.js";
import { BullmqJobQueue } from "../../src/jobs/bullmq-queue.js";
import { createRedisConnection } from "../../src/jobs/redis.js";
import { COMIC_IMAGE_TASK, COMIC_RENDER_TASK, COMIC_VIDEO_TASK, DIGITAL_PRESENTER_TASK, marketingPoolIssue } from "../../src/jobs/task-queues.js";
import { ffmpeg, mediaProcess } from "../../src/marketing-video/media.js";

export async function checkMixedMediaQueue(publisher: BullmqJobQueue, database: URL, redis: string) {
  const limits = { concurrency: 2, perUser: 1, segments: 2 };
  const poolMax = 6;
  assert.ok(marketingPoolIssue(limits, poolMax - 1));
  assert.equal(marketingPoolIssue(limits, poolMax), "");
  const db = new DB({ host: database.hostname, port: Number(database.port), user: decodeURIComponent(database.username),
    password: decodeURIComponent(database.password), database: database.pathname.slice(1), max: poolMax });
  const all = ["marketing.video", COMIC_VIDEO_TASK, COMIC_IMAGE_TASK, COMIC_RENDER_TASK, DIGITAL_PRESENTER_TASK];
  const types = Array.from({ length: 24 }, (_, i) => i % 2 === 0 ? all[0] : all[1 + Math.floor(i / 2) % (all.length - 1)]);
  try {
    await phase("marketing-100ms", types.map(() => all[0]), false);
    await phase("mixed-100ms", types, false);
    await phase("mixed-ffmpeg", types, true);
  } finally { await db.close(); }

  async function phase(label: string, jobs: string[], real: boolean) {
    const owners = jobs.map(() => randomUUID());
    await db.pool.query("INSERT INTO users(id,name) SELECT unnest($1::uuid[]),'mixed media fixture'", [owners]);
    const worker = new BullmqJobQueue(db, createRedisConnection(redis), limits);
    let processes = 0, peakFfmpeg = 0, peakPool = 0, peakWaiting = 0, handlers = 0, peakHandlers = 0;
    const sample = () => {
      peakPool = Math.max(peakPool, db.pool.totalCount - db.pool.idleCount);
      peakWaiting = Math.max(peakWaiting, db.pool.waitingCount);
    };
    const timer = setInterval(sample, 5);
    try {
      for (const type of all) {
        worker.process(type, async (job, control) => {
          const waitMs = Math.max(0, Date.now() - Date.parse(job.createdAt));
          const connection = await db.pool.connect();
          peakHandlers = Math.max(peakHandlers, ++handlers);
          sample();
          try {
            // A long-held worker connection plus a short companion mirrors the render and probe paths.
            await db.pool.query("SELECT 1");
            if (real) {
              peakFfmpeg = Math.max(peakFfmpeg, ++processes);
              try {
                await mediaProcess(ffmpeg(), ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
                  "-vf", "scale=640:360", "-c:v", "libx264", "-threads", "1", "-f", "null", "-"], { signal: control.signal, timeoutMs: 15_000 });
              } finally { processes--; }
            } else await delay(100, undefined, { signal: control.signal });
            await db.pool.query("SELECT 1");
            return { type, waitMs };
          } finally { handlers--; connection.release(); sample(); }
        });
      }
      worker.process("image.generate", async () => ({ ordinary: true }));
      const start = Date.now();
      const ids = await Promise.all(jobs.map((type, i) => publisher.enqueue(type, {}, owners[i], { maxAttempts: 1 })));
      const ordinary = await publisher.enqueue("image.generate", {}, owners[0], { maxAttempts: 1 });
      const metricsDb = new DB({ host: database.hostname, port: Number(database.port), user: decodeURIComponent(database.username),
        password: decodeURIComponent(database.password), database: database.pathname.slice(1), max: 2 });
      try {
        let rows: { status: string; id: string; output: { type: string; waitMs: number }; updated_at: Date }[] = [];
        while (Date.now() - start < 25_000) {
          rows = (await metricsDb.pool.query("SELECT id,status,output,updated_at FROM tasks WHERE id=ANY($1::uuid[])", [[...ids, ordinary]])).rows;
          assert.equal(rows.some(row => row.status === "failed"), false);
          if (rows.length === jobs.length + 1 && rows.every(row => row.status === "succeeded")) break;
          await delay(20);
        }
        assert.equal(rows.filter(row => row.status === "succeeded").length, jobs.length + 1);
        const ordinaryDone = rows.find(row => row.id === ordinary)!;
        const marketing = rows.filter(row => row.id !== ordinary && row.output.type === "marketing.video").map(row => row.output.waitMs).sort((a, b) => a - b);
        const samplePercentile = (p: number) => marketing[Math.ceil(p * marketing.length) - 1];
        assert.equal(peakHandlers, limits.concurrency);
        assert.ok(peakPool <= poolMax);
        if (real) assert.equal(peakFfmpeg, limits.concurrency);
        assert.ok(rows.some(row => row.updated_at > ordinaryDone.updated_at && row.id !== ordinary), "ordinary work finishes before the media wave");
        console.log("W7_QUEUE", JSON.stringify({ label, total: jobs.length, marketing: marketing.length, p50Ms: samplePercentile(.50),
          p95Ms: samplePercentile(.95), wallMs: Date.now() - start, peakPool, peakWaiting, peakFfmpeg, ordinaryDoneMs: +ordinaryDone.updated_at - start }));
      } finally { await metricsDb.close(); }
    } finally { clearInterval(timer); await worker.close(); }
  }
}
