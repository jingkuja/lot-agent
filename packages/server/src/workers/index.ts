import { randomUUID } from "node:crypto";
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
import { loadGenerationConfig, makeImageProvider, makeVideoProvider } from "../generation/config.js";
import { lastTurn } from "../memory/last-turn.js";
import { UsageMeter } from "../billing/meter.js";
import { GenCache, genCacheKey } from "../billing/gen-cache.js";
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
  const imageProvider = makeImageProvider(genConfig);
  const videoProvider = makeVideoProvider(genConfig);

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

  // Background memory extraction deps
  const llmConfig = await loadLlmConfig(ROOT);
  const extractLlm = createLLMProvider(llmConfig);
  const memAdapter = new PgMemoryAdapter(db.pool);
  await memAdapter.init();
  const extractModelId =
    llmConfig.default === "openai" ? llmConfig.openai.model : llmConfig.anthropic.model;

  // Register image.generate handler
  queue.process("image.generate", async (job) => {
    const input = job.input as Record<string, unknown>;
    const prompt = (input.prompt as string) ?? "";
    const assistantMessageId = input.assistantMessageId as string | undefined;
    const baseMeta = {
      kind: "generation",
      mediaType: "image",
      prompt,
      settings: { size: input.size, n: input.n },
    };
    try {
      const cacheKey = genCacheKey("image.generate", job.input);
      const cached = await cache.get<{ assetIds: string[]; assets: { url: string; mime: string }[] }>(cacheKey);
      if (!cached) await queue.updateProgress(job.id, 25);

      const result =
        cached ??
        (await (async () => {
          const r = await imageProvider.generate({
            prompt,
            size: input.size as string | undefined,
            n: input.n as number | undefined,
          });
          await queue.updateProgress(job.id, 70);
          const assets: { url: string; mime: string }[] = [];
          const assetIds: string[] = [];
          for (const d of r.data) {
            const { body, mime } = await urlToBytes(d.url);
            const assetId = randomUUID();
            const key = `${assetId}.${extFor(mime)}`;
            const { url } = await storage.put({ key, body, contentType: mime });
            await db.createAsset({
              id: assetId, taskId: job.id, userId: job.userId, type: "image",
              storageKey: key, url, mime, sizeBytes: body.byteLength,
            });
            assets.push({ url, mime });
            assetIds.push(assetId);
          }
          await meter.record({
            userId: job.userId, taskId: job.id, modelId: genConfig.image.modelId,
            usage: { inputCount: 0, outputCount: r.data.length },
          });
          const out = { assetIds, assets };
          await cache.set(cacheKey, out);
          return out;
        })());

      if (assistantMessageId) {
        await db.updateMessageGeneration(assistantMessageId, {
          status: "completed",
          metadata: { ...baseMeta, status: "completed", assets: result.assets },
        });
      }
      await queue.updateProgress(job.id, 100);
      return result;
    } catch (err) {
      if (assistantMessageId) {
        await db.updateMessageGeneration(assistantMessageId, {
          status: "failed",
          metadata: { ...baseMeta, status: "failed", error: err instanceof Error ? err.message : String(err) },
        });
      }
      throw err;
    }
  });

  // Register video.generate handler
  queue.process("video.generate", async (job) => {
    const input = job.input as Record<string, unknown>;
    const prompt = (input.prompt as string) ?? "";
    const assistantMessageId = input.assistantMessageId as string | undefined;
    const baseMeta = {
      kind: "generation",
      mediaType: "video",
      prompt,
      settings: { size: input.size, durationSec: input.durationSec, ratio: input.ratio },
    };
    try {
      const cacheKey = genCacheKey("video.generate", job.input);
      const cached = await cache.get<{ assetIds: string[]; assets: { url: string; mime: string; durationSec: number }[] }>(cacheKey);
      if (!cached) await queue.updateProgress(job.id, 25);

      const result =
        cached ??
        (await (async () => {
          const r = await videoProvider.generate({
            prompt,
            size: input.size as string | undefined,
            durationSec: input.durationSec as number | undefined,
            ratio: input.ratio as string | undefined,
          });
          await queue.updateProgress(job.id, 70);
          const { body, mime } = await urlToBytes(r.data[0].url);
          const assetId = randomUUID();
          const key = `${assetId}.${extFor(mime)}`;
          const { url } = await storage.put({ key, body, contentType: mime });
          await db.createAsset({
            id: assetId, taskId: job.id, userId: job.userId, type: "video",
            storageKey: key, url, mime, sizeBytes: body.byteLength, durationSec: r.durationSec,
          });
          await meter.record({
            userId: job.userId, taskId: job.id, modelId: genConfig.video.modelId,
            usage: { inputCount: 0, outputCount: r.durationSec },
          });
          const out = { assetIds: [assetId], assets: [{ url, mime, durationSec: r.durationSec }] };
          await cache.set(cacheKey, out);
          return out;
        })());

      if (assistantMessageId) {
        await db.updateMessageGeneration(assistantMessageId, {
          status: "completed",
          metadata: { ...baseMeta, status: "completed", assets: result.assets },
        });
      }
      await queue.updateProgress(job.id, 100);
      return result;
    } catch (err) {
      if (assistantMessageId) {
        await db.updateMessageGeneration(assistantMessageId, {
          status: "failed",
          metadata: { ...baseMeta, status: "failed", error: err instanceof Error ? err.message : String(err) },
        });
      }
      throw err;
    }
  });

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
