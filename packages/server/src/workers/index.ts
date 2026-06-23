import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DB } from "../db/database.js";
import { createRedisConnection } from "../jobs/redis.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { StubImageProvider, StubVideoProvider, LocalStorage } from "@lot-agent/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Worker file is at {src,dist}/workers/index.js → repo root is 4 levels up
// (one deeper than server's index.js, which sits at {src,dist}/index.js).
const ROOT = resolve(__dirname, "../../../..");
const ASSETS_DIR = resolve(ROOT, "data/assets");
const storage = new LocalStorage(ASSETS_DIR);

async function main() {
  const pgPassword = process.env.PG_PASSWORD;
  if (!pgPassword) throw new Error("PG_PASSWORD is required");

  const db = new DB({
    host: process.env.PG_HOST ?? "localhost",
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER ?? "postgres",
    password: pgPassword,
    database: process.env.PG_DATABASE ?? "lot",
  });

  await db.init();

  const conn = createRedisConnection(process.env.REDIS_URL);
  const queue = new BullmqJobQueue(db, conn);

  // Register image.generate handler
  queue.process("image.generate", async (job) => {
    const prompt = (job.input as Record<string, unknown>).prompt as string ?? "";
    await queue.updateProgress(job.id, 25);
    const r = await new StubImageProvider().generate({ prompt });
    await queue.updateProgress(job.id, 75);
    const assetId = randomUUID();
    const key = `${assetId}.png`;
    const placeholder = Buffer.from(
      JSON.stringify({ stub: "image", prompt, sourceUrl: r.images[0].url })
    );
    const { url } = await storage.put({ key, body: placeholder, contentType: "image/png" });
    await db.createAsset({
      id: assetId,
      taskId: job.id,
      userId: "default",
      type: "image",
      storageKey: key,
      url,
      mime: "image/png",
      sizeBytes: placeholder.byteLength,
    });
    await queue.updateProgress(job.id, 100);
    return { assetIds: [assetId], url };
  });

  // Register video.generate handler
  queue.process("video.generate", async (job) => {
    const input = job.input as Record<string, unknown>;
    const prompt = input.prompt as string ?? "";
    await queue.updateProgress(job.id, 25);
    const r = await new StubVideoProvider().generate({
      prompt,
      durationSec: input.durationSec as number | undefined,
    });
    await queue.updateProgress(job.id, 75);
    const assetId = randomUUID();
    const key = `${assetId}.mp4`;
    const placeholder = Buffer.from(
      JSON.stringify({ stub: "video", prompt, sourceUrl: r.videoUrl })
    );
    const { url } = await storage.put({ key, body: placeholder, contentType: "video/mp4" });
    await db.createAsset({
      id: assetId,
      taskId: job.id,
      userId: "default",
      type: "video",
      storageKey: key,
      url,
      mime: "video/mp4",
      sizeBytes: placeholder.byteLength,
      durationSec: r.durationSec,
    });
    await queue.updateProgress(job.id, 100);
    return { assetIds: [assetId], url, durationSec: r.durationSec };
  });

  console.log("Worker started, listening for jobs");

  process.on("SIGINT", async () => {
    console.log("\nWorker shutting down...");
    await queue.close();
    await db.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Worker failed to start:", error);
  process.exit(1);
});
