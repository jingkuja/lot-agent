import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { staticFileHandler } from "./static-files.js";
import { AgentService, type ServiceConfig } from "./services/agent-service.js";
import { createAuthMiddleware } from "./auth/middleware.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createConversationRoutes, createGenerationRoutes } from "./routes/conversations.js";
import { createSkillRoutes } from "./routes/skills.js";
import { createTraceRoutes } from "./routes/traces.js";
import { createRatingRoutes } from "./routes/ratings.js";
import { createMemoryRoutes } from "./routes/memory.js";
import { createAgentRoutes } from "./routes/agents.js";
import { createTaskRoutes } from "./routes/tasks.js";
import { createModelRoutes } from "./routes/models.js";
import { createKeyRoutes } from "./routes/keys.js";
import { createAssetRoutes } from "./routes/assets.js";
import { createUploadRoutes } from "./routes/uploads.js";
import { createUsageRoutes } from "./routes/usage.js";
import { createPlatformRoutes, createPublishRoutes } from "./routes/publish.js";
import { AppConfigSchema } from "@lot-agent/core";
import { loadLlmConfig } from "./config.js";
import { rateLimit, clientIp } from "./middleware/rate-limit.js";
import { RedisRateLimitStore } from "./middleware/redis-rate-limit-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const ASSETS_DIR = resolve(ROOT, "data/assets");
// Skill-generated documents live in their own store, separate from the
// image/video material in data/assets.
const DOCS_DIR = resolve(ROOT, "data/documents");
// User-uploaded files, served at /static/uploads.
const UPLOADS_DIR = resolve(ROOT, "data/uploads");
const DEFAULT_CORS_ORIGINS = ["http://localhost:5173", "https://aigc.todoucloud.com"];

async function loadConfig(): Promise<ServiceConfig> {
  const llm = await loadLlmConfig(ROOT);

  const configPath = resolve(ROOT, "config/default.json");
  const raw = JSON.parse(await readFile(configPath, "utf-8"));
  const config = AppConfigSchema.parse(raw);
  // `modelCatalog` is read directly from the raw JSON (like `generation`) since
  // AppConfigSchema strips unknown keys.
  const modelCatalog = (raw as { modelCatalog: ServiceConfig["modelCatalog"] }).modelCatalog;

  const pgPassword = process.env.PG_PASSWORD;
  if (!pgPassword) throw new Error("PG_PASSWORD is required");

  return {
    llm,
    models: config.models ?? [],
    modelCatalog,
    debug: process.env.DEBUG === "1",
    agent: config.agent as ServiceConfig["agent"],
    mcpConfigPath: resolve(ROOT, "config/mcp-servers.json"),
    skillsDir: resolve(ROOT, "skills"),
    db: {
      host: process.env.PG_HOST ?? "localhost",
      port: Number(process.env.PG_PORT) || 5432,
      user: process.env.PG_USER ?? "postgres",
      password: pgPassword,
      database: process.env.PG_DATABASE ?? "lot",
    },
  };
}

async function main() {
  const serviceConfig = await loadConfig();

  if (!serviceConfig.llm.openai.apiKey && !serviceConfig.llm.anthropic.apiKey) {
    console.warn("WARNING: No LLM API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY");
  }

  const service = new AgentService(serviceConfig);
  await service.init();

  // Sessions hard-expire after 7 days (session-store.ts) but expired rows are
  // never otherwise deleted (#16) — sweep once at startup, then hourly. Runs
  // detached from the process lifecycle (`.unref()`) and never lets a sweep
  // failure crash the server.
  const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  const sweepExpiredSessions = async () => {
    try {
      const deleted = await service.db.deleteExpiredSessions();
      if (deleted > 0) console.log(`Cleaned up ${deleted} expired session(s)`);
    } catch (err) {
      console.warn("Session cleanup failed:", err);
    }
  };
  void sweepExpiredSessions();
  setInterval(sweepExpiredSessions, SESSION_CLEANUP_INTERVAL_MS).unref();

  // Generation tasks are enqueued to Redis and consumed by a SEPARATE worker
  // process. If that worker is down or misconfigured (crashed on startup for a
  // missing env key, pointed at the wrong Redis DB, or simply not running), its
  // jobs are never claimed and the tasks — plus the "生成中" cards bound to them —
  // hang at 'pending' forever. This server-side sweep (the server is the always-
  // up process) fails tasks that were never picked up (attempts 0) beyond the
  // threshold and flips their generation message to 'failed', so the UI shows a
  // visible failure with a diagnostic instead of an endless spinner. Same
  // detached (`.unref()`), never-crash-the-server shape as the session sweep.
  const STALE_TASK_MS = 3 * 60 * 1000; // never-claimed after 3 min ⇒ worker not consuming
  const STALE_TASK_SWEEP_INTERVAL_MS = 60 * 1000;
  const reapStalePendingTasks = async () => {
    try {
      const failed = await service.db.failStalePendingTasks(
        STALE_TASK_MS,
        "任务未被处理：generation worker 不可用（队列未被消费，请检查 worker 是否启动、REDIS_URL/DB 是否一致）"
      );
      for (const t of failed) {
        const input = (t.input ?? {}) as Record<string, unknown>;
        const messageId = input.assistantMessageId as string | undefined;
        const conversationId = input.conversationId as string | undefined;
        if (messageId && conversationId) {
          await service.db
            .markMessageGenerationFailed(messageId, t.error ?? "worker unavailable", {
              conversationId,
              userId: t.user_id,
            })
            .catch(() => {});
        }
      }
      if (failed.length > 0) {
        console.warn(
          `[stale-task-reaper] failed ${failed.length} unclaimed task(s) — is the generation worker running and on the same REDIS_URL DB?`
        );
      }
    } catch (err) {
      console.warn("Stale task reaper failed:", err);
    }
  };
  void reapStalePendingTasks();
  setInterval(reapStalePendingTasks, STALE_TASK_SWEEP_INTERVAL_MS).unref();

  // Debug mode (DEBUG=1): seed a stable login-less user whose empty key set makes
  // every provider resolution fall through to the env LLM. externalUserId 0 is
  // reserved (real users get their id from tokenhub).
  if (serviceConfig.debug) {
    const debugUser = await service.db.upsertUserByExternalId({
      externalUserId: 0,
      username: "debug",
      apiKeys: [],
    });
    service.debugUserId = debugUser.id;
    console.warn("DEBUG=1: auth disabled, using env model/key. Do NOT use in production.");
  }

  const app = new Hono<{ Variables: { userId: string } }>();

  // ── Rate limiting (report.md #21) ──────────────────────────────────────
  // Fixed-window counters on the shared Redis connection (same one used for
  // the model-catalog cache / session memory — see agent-service.ts `init`).
  // A single centralized table of limits so every endpoint's quota is
  // reviewable at a glance; store failures fail OPEN (see rate-limit.ts).
  const rateLimitStore = new RedisRateLimitStore(service.redis);
  const RATE_LIMITS = {
    // Login endpoints are unauthenticated (no userId yet) — keyed by IP.
    // /login and /token-login share one bucket: both are password/token
    // exchange attempts against the same abuse surface.
    login: { prefix: "rl:login", limit: 10, windowMs: 5 * 60 * 1000 },
    // Everything below is keyed by userId (post-authMw).
    upload: { prefix: "rl:upload", limit: 30, windowMs: 60 * 1000 },
    // Chat send + regenerate share one bucket: both trigger an LLM turn.
    messages: { prefix: "rl:messages", limit: 30, windowMs: 60 * 1000 },
    // In-conversation generation + the standalone task API share one bucket:
    // both enqueue the same billed image/video jobs.
    generation: { prefix: "rl:generation", limit: 10, windowMs: 60 * 1000 },
  } as const;
  const loginRateLimit = rateLimit({ store: rateLimitStore, keyFn: clientIp, ...RATE_LIMITS.login });
  const uploadRateLimit = rateLimit({
    store: rateLimitStore,
    keyFn: (c) => c.get("userId"),
    ...RATE_LIMITS.upload,
  });
  const messagesRateLimit = rateLimit({
    store: rateLimitStore,
    keyFn: (c) => c.get("userId"),
    ...RATE_LIMITS.messages,
  });
  const generationRateLimit = rateLimit({
    store: rateLimitStore,
    keyFn: (c) => c.get("userId"),
    ...RATE_LIMITS.generation,
  });

  app.use("*", logger());
  app.use("*", cors({
    origin: (process.env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGINS.join(",")).split(","),
    credentials: true,
  }));

  // Public routes
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Auth routes — PUBLIC (no bearer token required). Rate limit mounted on
  // the exact POST paths (method+path match) BEFORE the route below, so it
  // runs first in the chain without touching GET /public-key, /mode, /me.
  app.on("POST", "/api/auth/login", loginRateLimit);
  app.on("POST", "/api/auth/token-login", loginRateLimit);
  app.route("/api/auth", createAuthRoutes(service));

  // Auth guard for all other /api/* routes
  const authMw = createAuthMiddleware(service.sessions, {
    debug: serviceConfig.debug,
    debugUserId: service.debugUserId,
  });
  app.use("/api/conversations/*", authMw);
  app.use("/api/skills/*", authMw);
  app.use("/api/traces/*", authMw);
  app.use("/api/ratings/*", authMw);
  app.use("/api/memory/*", authMw);
  app.use("/api/agents", authMw);
  app.use("/api/agents/*", authMw);
  app.use("/api/models", authMw);
  app.use("/api/models/*", authMw);
  app.use("/api/keys/*", authMw);
  app.use("/api/tasks/*", authMw);
  app.use("/api/assets/*", authMw);
  app.use("/api/uploads/*", authMw);
  app.use("/api/usage/*", authMw);
  app.use("/api/balance", authMw);
  app.use("/api/platform/*", authMw);
  app.use("/api/publish/*", authMw);

  // userId-keyed rate limits — registered after authMw (so `userId` is set)
  // and before the route handlers below. Exact method+path so GET/SSE-poll
  // traffic (model list, task polling, etc.) is never limited.
  app.on("POST", "/api/uploads", uploadRateLimit);
  app.on("POST", "/api/conversations/:id/messages", messagesRateLimit);
  app.on("POST", "/api/conversations/:id/regenerate", messagesRateLimit);
  app.on("POST", "/api/conversations/:id/generations", generationRateLimit);
  app.on("POST", "/api/tasks", generationRateLimit);

  // Protected API routes
  app.route("/api/conversations", createConversationRoutes(service));
  app.route("/api/conversations", createGenerationRoutes(service));
  app.route("/api/skills", createSkillRoutes(service));
  app.route("/api/traces", createTraceRoutes(service));
  app.route("/api/ratings", createRatingRoutes(service));
  app.route("/api/memory", createMemoryRoutes(service));
  app.route("/api/agents", createAgentRoutes(service));
  app.route("/api/models", createModelRoutes(service));
  app.route("/api/keys", createKeyRoutes(service));
  app.route("/api/tasks", createTaskRoutes(service));
  app.route("/api/assets", createAssetRoutes(service));
  app.route("/api/uploads", createUploadRoutes(service));
  app.route("/api/usage", createUsageRoutes(service));
  app.route("/api/platform", createPlatformRoutes(service));
  app.route("/api/publish", createPublishRoutes(service));

  // /api/balance alias → same balance logic, user-scoped
  app.get("/api/balance", async (c) => {
    const userId = c.get("userId");
    const [bal, dailySpend, monthlySpend] = await Promise.all([
      service.db.ensureUserBalance(userId),
      service.db.getDailySpend(userId),
      service.db.getMonthlySpend(userId),
    ]);
    return c.json({
      balance: bal.balance,
      daily_limit: bal.daily_limit,
      monthly_limit: bal.monthly_limit,
      dailySpend,
      monthlySpend,
    });
  });

  // Static file serving is centralized in static-files.ts: streamed bodies
  // (Range support, no full-buffer reads) and a shared content policy that
  // isolates active content (HTML, SVG) from same-origin inline rendering —
  // see contentPolicy() for the whitelist rationale.
  app.get("/static/assets/:filename", staticFileHandler(ASSETS_DIR));
  app.get("/static/documents/:filename", staticFileHandler(DOCS_DIR));
  app.get("/static/uploads/:filename", staticFileHandler(UPLOADS_DIR));

  const port = Number(process.env.PORT) || 3000;

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await service.shutdown();
    process.exit(0);
  });

  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    console.log(`Server listening on 0.0.0.0:${info.port}`);
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
