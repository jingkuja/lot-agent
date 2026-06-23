import { DB } from "../db/database.js";
import { createRedisConnection } from "../jobs/redis.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { StubImageProvider, StubVideoProvider } from "@lot-agent/core";

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
    await queue.updateProgress(job.id, 25);
    const r = await new StubImageProvider().generate({
      prompt: (job.input as Record<string, unknown>).prompt as string ?? "",
    });
    await queue.updateProgress(job.id, 75);
    return { imageUrl: r.images[0].url };
  });

  // Register video.generate handler
  queue.process("video.generate", async (job) => {
    await queue.updateProgress(job.id, 25);
    const input = job.input as Record<string, unknown>;
    const r = await new StubVideoProvider().generate({
      prompt: input.prompt as string ?? "",
      durationSec: input.durationSec as number | undefined,
    });
    await queue.updateProgress(job.id, 75);
    return { videoUrl: r.videoUrl, durationSec: r.durationSec };
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
