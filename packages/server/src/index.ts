import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentService, type ServiceConfig } from "./services/agent-service.js";
import { createConversationRoutes } from "./routes/conversations.js";
import { createSkillRoutes } from "./routes/skills.js";
import { createTraceRoutes } from "./routes/traces.js";
import { createRatingRoutes } from "./routes/ratings.js";
import type { LLMConfig } from "@lot-agent/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");

async function loadConfig(): Promise<ServiceConfig> {
  const configPath = resolve(ROOT, "config/default.json");
  const raw = await readFile(configPath, "utf-8");
  const config = JSON.parse(raw);

  // Environment variables override config file
  const llm = config.llm as LLMConfig;
  if (process.env.OPENAI_API_KEY) llm.openai.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_BASE_URL) llm.openai.baseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_MODEL) llm.openai.model = process.env.OPENAI_MODEL;
  if (process.env.ANTHROPIC_API_KEY) llm.anthropic.apiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_MODEL) llm.anthropic.model = process.env.ANTHROPIC_MODEL;
  if (process.env.LLM_DEFAULT) llm.default = process.env.LLM_DEFAULT as LLMConfig["default"];

  return {
    llm,
    agent: config.agent ?? {},
    mcpConfigPath: resolve(ROOT, "config/mcp-servers.json"),
    skillsDir: resolve(ROOT, "skills"),
    db: {
      host: process.env.PG_HOST ?? "localhost",
      port: Number(process.env.PG_PORT) ?? 5432,
      user: process.env.PG_USER ?? "postgres",
      password: process.env.PG_PASSWORD ?? "rag123456",
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

  const app = new Hono();

  app.use("*", logger());
  app.use("*", cors());

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/api/conversations", createConversationRoutes(service));
  app.route("/api/skills", createSkillRoutes(service));
  app.route("/api/traces", createTraceRoutes(service));
  app.route("/api/ratings", createRatingRoutes(service));

  const port = Number(process.env.PORT) || 3000;

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await service.shutdown();
    process.exit(0);
  });

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Server running on http://localhost:${info.port}`);
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
