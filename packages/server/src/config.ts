import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppConfigSchema } from "@lot-agent/core";
import type { LLMConfig } from "@lot-agent/core";

/**
 * Load the LLM config from {rootDir}/config/default.json, applying
 * OPENAI_* / ANTHROPIC_* / LLM_DEFAULT env overrides before validation.
 * Shared by the API server and the background worker.
 */
export async function loadLlmConfig(rootDir: string): Promise<LLMConfig> {
  const configPath = resolve(rootDir, "config/default.json");
  const rawConfig = JSON.parse(await readFile(configPath, "utf-8"));

  const llmRaw = rawConfig.llm ?? {};
  const openaiRaw = llmRaw.openai ?? {};
  const anthropicRaw = llmRaw.anthropic ?? {};

  if (process.env.OPENAI_API_KEY) openaiRaw.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_BASE_URL) openaiRaw.baseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_MODEL) openaiRaw.model = process.env.OPENAI_MODEL;
  if (process.env.ANTHROPIC_API_KEY) anthropicRaw.apiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_MODEL) anthropicRaw.model = process.env.ANTHROPIC_MODEL;
  if (process.env.LLM_DEFAULT) llmRaw.default = process.env.LLM_DEFAULT;

  llmRaw.openai = openaiRaw;
  llmRaw.anthropic = anthropicRaw;
  rawConfig.llm = llmRaw;

  const config = AppConfigSchema.parse(rawConfig);
  return config.llm as LLMConfig;
}
