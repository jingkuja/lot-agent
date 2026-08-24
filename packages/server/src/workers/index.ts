import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { DB } from "../db/database.js";
import { createRedisConnection } from "../jobs/redis.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { LocalStorage, complete, fetchPublicBinary } from "@lot-agent/core";
import type { ModelConfig } from "@lot-agent/core";
import {
  PgMemoryAdapter,
  buildExtractionMessages,
  parseExtraction,
  applyExtraction,
} from "@lot-agent/core";
import { loadLlmConfig } from "../config.js";
import { loadGenerationConfig, makeImageProvider, makeVideoProvider } from "../generation/config.js";
import { runGenerationJob, redownloadGenerationJob, type RunJobDeps } from "../generation/run-job.js";
import { ProviderFactory } from "../models/provider-factory.js";
import {
  DIGITAL_EMPLOYEE_LLM_UNAVAILABLE,
  resolveDigitalEmployeeLlm,
} from "../models/digital-employee-llm.js";
import type { ModelCatalogConfig } from "../models/catalog.js";
import { TokenhubClient } from "../tokenhub/client.js";
import { pickGenModel } from "./gen-provider.js";
import { lastTurn } from "../memory/last-turn.js";
import { UsageMeter } from "../billing/meter.js";
import { makePricingLookup } from "../billing/pricing-lookup.js";
import { GenCache } from "../billing/gen-cache.js";
import { staticPrefix } from "../util/public-base.js";
import { createOptionalFallbackLLM } from "./fallback-llm.js";
import { OpportunityService, type OpportunityAdvicePatch } from "../digital-employee/opportunity-service.js";
import { meterLLM } from "../billing/metered-llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Worker file is at {src,dist}/workers/index.js → repo root is 4 levels up
// (one deeper than server's index.js, which sits at {src,dist}/index.js).
const ROOT = resolve(__dirname, "../../../..");
const ASSETS_DIR = resolve(ROOT, "data/assets");
const UPLOADS_DIR = resolve(ROOT, "data/uploads");
const storage = new LocalStorage(ASSETS_DIR, staticPrefix("/static/assets"));
const uploadStorage = new LocalStorage(UPLOADS_DIR, staticPrefix("/static/uploads"));

// Vendor-returned generation URLs are untrusted input (parsed out of a model
// response) — download them defensively: SSRF-guarded (incl. redirect hops),
// time-boxed, and capped so a malicious/misbehaving vendor response can't
// exhaust worker memory. Sizes are generous upper bounds, not typical output.
const IMAGE_MAX_BYTES = 30 * 1024 * 1024; // 30MB
const VIDEO_MAX_BYTES = 300 * 1024 * 1024; // 300MB

// Download time budgets. Videos are far larger than images and come off the
// vendor's CDN over links of unknown speed, so the fetch default (120s) is
// systematically too short for them — a completed generation would then read
// as "download timed out". Give video a generous 5-minute budget; a failure is
// still recoverable via the download-only retry (generation.redownload).
const IMAGE_DOWNLOAD_TIMEOUT_MS = 120_000; // 2min
const VIDEO_DOWNLOAD_TIMEOUT_MS = 5 * 60_000; // 5min

function safeUploadKeyFromUrl(url: string): string | null {
  const prefix = staticPrefix("/static/uploads/");
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  return key && !key.includes("/") && !key.includes("\\") && !key.includes("..") ? key : null;
}

function imageMimeForUpload(key: string, body: Buffer): string | null {
  const ext = extname(key).toLowerCase();
  if (ext === ".png" || body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (ext === ".jpg" || ext === ".jpeg" || (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)) return "image/jpeg";
  if (ext === ".webp" || body.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (ext === ".gif" || body.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return null;
}

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

  // The worker intentionally does NOT run migrations: schema is owned and
  // migrated by the server process (see DB.migrate / agent-service.ts). The
  // worker just uses the pool created in the DB constructor, so the two
  // processes stay independent at startup — no duplicate, no concurrent DDL,
  // no dependency on the server having migrated first.

  const conn = createRedisConnection(process.env.REDIS_URL);
  const queue = new BullmqJobQueue(db, conn);

  // Load model pricing from config
  const configPath = resolve(ROOT, "config/default.json");
  const rawConfig = JSON.parse(await readFile(configPath, "utf-8")) as {
    models?: ModelConfig[];
    modelCatalog: ModelCatalogConfig;
  };
  const models: ModelConfig[] = rawConfig.models ?? [];
  const modelMap = new Map(models.map((m) => [m.id, m]));
  const modelCatalog = rawConfig.modelCatalog;

  // Shares the same static-then-catalog pricing resolution as the server's
  // chat path (agent-service.ts) — otherwise a dynamic tokenhub model id
  // (e.g. memory.extract running on the triggering turn's model) is unknown
  // to `modelMap` and its usage silently goes unmetered (#18).
  const meter = new UsageMeter(db, makePricingLookup((id) => modelMap.get(id), modelCatalog));
  const cache = new GenCache(conn);

  const genConfig = await loadGenerationConfig(ROOT);
  const imageProvider = makeImageProvider(genConfig.image);
  const videoProvider = makeVideoProvider(genConfig.video);
  // Per-user provider factory: generation calls use the owning user's api_key.
  const providerFactory = new ProviderFactory({
    catalog: modelCatalog,
    llmBaseUrl: genConfig.image.baseUrl,
    imageBase: genConfig.image,
    videoBase: genConfig.video,
  });
  const tokenhub = new TokenhubClient(
    process.env.TOKENHUB_BASE_URL ?? "https://tokenhub.todoucloud.com/api/agent-market",
    undefined,
    process.env.NEW_API_AGENT_KEY ?? ""
  );

  const resolveDigitalEmployeeTaskLlm = async (userId: string) => {
    const activeApiKey = await db.getUserApiKey(userId);
    let apiKeys: string[] = [];
    try {
      apiKeys = (await db.getUserApiKeys(userId)).map((entry) => entry.apiKey);
    } catch {
      // The active key can still be tried when the stored key list is unavailable.
    }
    return resolveDigitalEmployeeLlm(
      activeApiKey,
      apiKeys,
      async (apiKey) => (await tokenhub.listModels(apiKey)).llm
    );
  };

  /**
   * Resolve a provider url (http(s) or data:) to bytes + mime, enforcing
   * `maxBytes` either way: `data:` URLs are decoded then length-checked (the
   * decode itself is bounded by the base64 already being in memory as part
   * of the vendor's poll response); http(s) URLs go through the SSRF-guarded,
   * streaming `fetchPublicBinary` so an oversized/malicious response is
   * aborted before it is fully buffered.
   */
  async function urlToBytes(
    url: string,
    maxBytes: number,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<{ body: Buffer; mime: string }> {
    if (url.startsWith("data:")) {
      const [head, b64] = url.slice(5).split(",", 2);
      const mime = head.split(";")[0] || "application/octet-stream";
      const body = Buffer.from(b64, "base64");
      if (body.byteLength > maxBytes) {
        throw new Error(`download exceeds maxBytes (${body.byteLength} > ${maxBytes})`);
      }
      return { body, mime };
    }
    // Image-edit references are normally uploads from this app. Read them
    // directly instead of requiring a public HTTP address (and without routing
    // the worker through its own SSRF-protected HTTP client).
    const uploadKey = safeUploadKeyFromUrl(url);
    if (uploadKey) {
      const body = await uploadStorage.get(uploadKey);
      const mime = imageMimeForUpload(uploadKey, body);
      if (!mime) throw new Error("uploaded edit reference is not a supported image");
      if (body.byteLength > maxBytes) {
        throw new Error(`download exceeds maxBytes (${body.byteLength} > ${maxBytes})`);
      }
      return { body, mime };
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    return fetchPublicBinary(url, { maxBytes, signal: opts.signal, timeoutMs: opts.timeoutMs });
  }

  /** Map a mime to a stored-file extension. */
  const extFor = (mime: string) =>
    mime.includes("svg") ? "svg" : mime.includes("mp4") ? "mp4" : mime.includes("png") ? "png" : mime.split("/")[1] ?? "bin";

  // Build job deps per task: the provider is bound to the owning user's api_key
  // and the task's selected model (falling back to the media type's configured
  // default). Billing stays on the configured, statically-priced modelId; the
  // selected model drives the actual generation and the per-model cache key.
  const genDeps = async (
    mediaType: "image" | "video",
    job: { userId: string; input: Record<string, unknown> },
    signal?: AbortSignal
  ): Promise<RunJobDeps> => {
    const base = mediaType === "image" ? genConfig.image : genConfig.video;
    const maxBytes = mediaType === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
    const downloadTimeoutMs = mediaType === "image" ? IMAGE_DOWNLOAD_TIMEOUT_MS : VIDEO_DOWNLOAD_TIMEOUT_MS;
    const model = pickGenModel(mediaType, job.input, base.modelId);
    const apiKey = (await db.getUserApiKey(job.userId)) ?? "";
    if (!apiKey && (job.input.requireUserModelKey === true || job.input.featureScope)) {
      throw new Error("数字员工生成任务缺少用户 TokenHub key");
    }
    const provider = apiKey
      ? mediaType === "image"
        ? providerFactory.image(model, apiKey)
        : providerFactory.video(model, apiKey)
      : mediaType === "image"
        ? imageProvider
        : videoProvider;
    return {
      provider,
      storage,
      db,
      meter,
      cache,
      updateProgress: (taskId, progress) => queue.updateProgress(taskId, progress),
      urlToBytes: (url, o) => urlToBytes(url, maxBytes, { ...o, timeoutMs: downloadTimeoutMs }),
      extFor,
      modelId: base.modelId,
      vendorModel: model,
      signal,
    };
  };

  // Background memory extraction deps. There's no shared/startup LLM here:
  // each job builds its provider from the triggering turn's own modelId +
  // the owning user's tokenhub key, same as chat/title generation — falling
  // back to the env-configured LLM only when either is unavailable (e.g. a
  // user without a tokenhub key, or an older queued job with no modelId).
  const llmConfig = await loadLlmConfig(ROOT);
  const fallbackExtractLlm = createOptionalFallbackLLM(llmConfig);
  const fallbackExtractModelId =
    llmConfig.default === "openai" ? llmConfig.openai.model : llmConfig.anthropic.model;
  const memAdapter = new PgMemoryAdapter(db.pool);
  await memAdapter.init();

  const opportunityService = new OpportunityService(db, undefined, {
    enhance: async ({ userId, taskId, opportunities }) => {
      const selection = await resolveDigitalEmployeeTaskLlm(userId);
      if (!selection) throw new Error(DIGITAL_EMPLOYEE_LLM_UNAVAILABLE);
      const modelId = selection.modelId;
      const llm = providerFactory.llm(selection.modelId, selection.apiKey);
      const meters: Promise<unknown>[] = [];
      const metered = meterLLM(llm, (usage) => {
        meters.push(meter.record({
          userId, taskId: taskId ?? undefined, modelId,
          usage: { inputCount: usage.promptTokens, outputCount: usage.completionTokens },
        }));
      });
      const raw = await complete(metered, [
        {
          role: "system",
          content:
            "你是商机雷达。根据服务端已经筛选和校验的候选商机，优化标题、目标、沟通方式和理由。" +
            "不得改变dedupKey、机会类型、优先级、事实证据或风险，不得添加联系方式或虚构事实。" +
            "仅输出JSON对象：{\"suggestions\":[{\"dedupKey\":\"...\",\"title\":\"...\",\"objective\":\"...\",\"method\":\"...\",\"reason\":\"...\"}]}。",
        },
        { role: "user", content: JSON.stringify({ opportunities }) },
      ], { signal: AbortSignal.timeout(45_000), params: { temperature: 0.2, maxTokens: 2_400 } });
      await Promise.allSettled(meters);
      return { modelId, patches: parseOpportunityAdvice(raw) };
    },
  });

  queue.process("image.generate", async (job, ctl) => {
    const j = { id: job.id, userId: job.userId, input: job.input as Record<string, unknown> };
    return runGenerationJob(await genDeps("image", j, ctl.signal), j, "image");
  });
  queue.process("video.generate", async (job, ctl) => {
    const j = { id: job.id, userId: job.userId, input: job.input as Record<string, unknown> };
    return runGenerationJob(await genDeps("video", j, ctl.signal), j, "video");
  });
  queue.process("opportunity.discover", async (job) => {
    const { runId } = job.input as { runId: string };
    return opportunityService.runDiscovery(job.userId, runId, (value, stage) => queue.updateProgress(job.id, value, stage));
  });

  // Download-only retry: the vendor generation already succeeded but pulling
  // the media into our storage failed (e.g. slow CDN → download timed out).
  // The job carries `sourceUrl` + `mediaType`; we re-fetch that url with the
  // owning user's deps and finalize, without re-calling / re-billing the vendor.
  queue.process("generation.redownload", async (job, ctl) => {
    const input = job.input as Record<string, unknown>;
    const mediaType = input.mediaType === "image" ? "image" : "video";
    const j = { id: job.id, userId: job.userId, input };
    return redownloadGenerationJob(await genDeps(mediaType, j, ctl.signal), j, mediaType);
  });

  // Register memory.extract handler — runs a cheap LLM to pull durable user
  // facts/preferences from the latest turn and persist them. Best-effort.
  queue.process("memory.extract", async (job) => {
    const { conversationId, modelId } = job.input as { conversationId: string; modelId?: string };
    const userId = job.userId;

    // Digital-employee facts belong in its controlled profile/marketing tables,
    // not user memory. This also guarantees old queued tasks cannot fall back
    // to an environment LLM after a user's TokenHub key disappears.
    if (await db.getConversationAgentId(conversationId) === "digital_employee") {
      await queue.updateProgress(job.id, 100);
      return { upserts: 0, deletes: 0 };
    }

    const messages = await db.getMessages(conversationId);
    const turn = lastTurn(messages);
    if (!turn) {
      await queue.updateProgress(job.id, 100);
      return { upserts: 0, deletes: 0 };
    }

    const existing = await memAdapter.list(userId);

    const apiKey = await db.getUserApiKey(userId);
    const extractLlm =
      apiKey && modelId
        ? providerFactory.llm(modelId, apiKey)
        : fallbackExtractLlm;
    const extractModelId = apiKey && modelId ? modelId : fallbackExtractModelId;
    if (!extractLlm) {
      console.warn(
        `[memory.extract] skipped task ${job.id}: no user or fallback LLM API key`
      );
      await queue.updateProgress(job.id, 100);
      return { upserts: 0, deletes: 0 };
    }

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

function parseOpportunityAdvice(raw: string): OpportunityAdvicePatch[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as { suggestions?: unknown };
  if (!Array.isArray(parsed.suggestions)) throw new Error("invalid opportunity advice response");
  return parsed.suggestions.filter((item): item is OpportunityAdvicePatch =>
    Boolean(item && typeof item === "object" && typeof (item as { dedupKey?: unknown }).dedupKey === "string")
  );
}
