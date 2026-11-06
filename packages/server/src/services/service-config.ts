import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppConfigSchema } from "@lot-agent/core";
import { loadLlmConfig } from "../config.js";
import { KnowledgeConfigSchema } from "../knowledge/module.js";
import { parseMiniprogramConfig } from "../miniprogram/models.js";
import type { ServiceConfig } from "./agent-service.js";

/** One reading of the config for every process that builds an AgentService. */
export async function loadServiceConfig(root: string): Promise<ServiceConfig> {
  const llm = await loadLlmConfig(root);

  const configPath = resolve(root, "config/default.json");
  const raw = JSON.parse(await readFile(configPath, "utf-8"));
  const config = AppConfigSchema.parse(raw);
  // `modelCatalog` is read directly from the raw JSON (like `generation`) since
  // AppConfigSchema strips unknown keys.
  const modelCatalog = (raw as { modelCatalog: ServiceConfig["modelCatalog"] }).modelCatalog;
  const miniprogram = parseMiniprogramConfig((raw as { miniprogram?: unknown }).miniprogram);

  const pgPassword = process.env.PG_PASSWORD;
  if (!pgPassword) throw new Error("PG_PASSWORD is required");

  return {
    llm,
    knowledge: KnowledgeConfigSchema.parse(raw.knowledge),
    models: config.models ?? [],
    modelCatalog,
    miniprogram,
    debug: process.env.DEBUG === "1",
    agent: config.agent as ServiceConfig["agent"],
    mcpConfigPath: resolve(root, "config/mcp-servers.json"),
    skillsDir: resolve(root, "skills"),
    db: {
      host: process.env.PG_HOST ?? "localhost",
      port: Number(process.env.PG_PORT) || 5432,
      user: process.env.PG_USER ?? "postgres",
      password: pgPassword,
      database: process.env.PG_DATABASE ?? "lot",
    },
  };
}
