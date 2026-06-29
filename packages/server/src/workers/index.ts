import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { DB } from "../db/database.js";
import { createRedisConnection } from "../jobs/redis.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { LocalStorage } from "@lot-agent/core";
import type { ModelConfig } from "@lot-agent/core";
import {
  createLLMProvider,
  PgMemoryAdapter,
  buildExtractionMessages,
  parseExtraction,
  applyExtraction,
} from "@lot-agent/core";
import { loadLlmConfig } from "../config.js";
import { loadGenerationConfig, makeGenerationProvider } from "../generation/config.js";
import { runGenerationJob, type RunJobDeps } from "../generation/run-job.js";
import { lastTurn } from "../memory/last-turn.js";
import { UsageMeter } from "../billing/meter.js";
import { GenCache } from "../billing/gen-cache.js";
import { staticPrefix } from "../util/public-base.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Worker file is at {src,dist}/workers/index.js → repo root is 4 levels up
// (one deeper than server's index.js, which sits at {src,dist}/index.js).
const ROOT = resolve(__dirname, "../../../..");
const ASSETS_DIR = resolve(ROOT, "data/assets");
const storage = new LocalStorage(ASSETS_DIR, staticPrefix("/static/assets"));

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

  // Load model pricing from config
  const configPath = resolve(ROOT, "config/default.json");
  const rawConfig = JSON.parse(await readFile(configPath, "utf-8")) as { models?: ModelConfig[] };
  const models: ModelConfig[] = rawConfig.models ?? [];
  const modelMap = new Map(models.map((m) => [m.id, m]));

  const meter = new UsageMeter(db, (id) => modelMap.get(id));
  const cache = new GenCache(conn);

  const genConfig = await loadGenerationConfig(ROOT);
  const generationProvider = makeGenerationProvider(genConfig);

  /** Resolve a provider url (http(s) or data:) to bytes + mime. */
  async function urlToBytes(url: string): Promise<{ body: Buffer; mime: string }> {
    if (url.startsWith("data:")) {
      const [head, b64] = url.slice(5).split(",", 2);
      const mime = head.split(";")[0] || "application/octet-stream";
      return { body: Buffer.from(b64, "base64"), mime };
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const mime = res.headers.get("content-type") ?? "application/octet-stream";
    return { body: Buffer.from(await res.arrayBuffer()), mime };
  }

  /** Map a mime to a stored-file extension. */
  const extFor = (mime: string) =>
    mime.includes("svg") ? "svg" : mime.includes("mp4") ? "mp4" : mime.includes("png") ? "png" : mime.split("/")[1] ?? "bin";

  const genDeps = (mediaType: "image" | "video"): RunJobDeps => ({
    provider: generationProvider,
    storage,
    db,
    meter,
    cache,
    updateProgress: (taskId, progress) => queue.updateProgress(taskId, progress),
    urlToBytes,
    extFor,
    modelId: mediaType === "image" ? genConfig.image.modelId : genConfig.video.modelId,
    vendorModel: mediaType === "image" ? genConfig.image.model : genConfig.video.model,
  });

  // Background memory extraction deps
  const llmConfig = await loadLlmConfig(ROOT);
  const extractLlm = createLLMProvider(llmConfig);
  const memAdapter = new PgMemoryAdapter(db.pool);
  await memAdapter.init();
  const extractModelId =
    llmConfig.default === "openai" ? llmConfig.openai.model : llmConfig.anthropic.model;

  queue.process("image.generate", (job) => runGenerationJob(genDeps("image"), { id: job.id, userId: job.userId, input: job.input as Record<string, unknown> }, "image"));
  queue.process("video.generate", (job) => runGenerationJob(genDeps("video"), { id: job.id, userId: job.userId, input: job.input as Record<string, unknown> }, "video"));

  // Register memory.extract handler — runs a cheap LLM to pull durable user
  // facts/preferences from the latest turn and persist them. Best-effort.
  queue.process("memory.extract", async (job) => {
    const { conversationId } = job.input as { conversationId: string };
    const userId = job.userId;

    const messages = await db.getMessages(conversationId);
    const turn = lastTurn(messages);
    if (!turn) {
      await queue.updateProgress(job.id, 100);
      return { upserts: 0, deletes: 0 };
    }

    const existing = await memAdapter.list(userId);

    let raw = "";
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of extractLlm.chat(buildExtractionMessages(turn, existing))) {
      if (chunk.type === "text") raw += chunk.content ?? "";
      if (chunk.type === "done" && chunk.usage) {
        inputTokens = chunk.usage.promptTokens;
        outputTokens = chunk.usage.completionTokens;
      }
    }

    const ext = parseExtraction(raw);
    await applyExtraction(memAdapter, userId, ext);

    if (inputTokens + outputTokens > 0) {
      try {
        await meter.record({
          userId,
          taskId: job.id,
          modelId: extractModelId,
          usage: { inputCount: inputTokens, outputCount: outputTokens },
        });
      } catch (err) {
        console.warn("[memory.extract] meter failed:", err);
      }
    }

    await queue.updateProgress(job.id, 100);
    return { upserts: ext.upserts.length, deletes: ext.deletes.length };
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
