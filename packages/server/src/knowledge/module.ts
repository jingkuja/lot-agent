import { KnowledgeConfigSchema, type KnowledgeConfig, type KnowledgeService } from "@lot-agent/core";
import { KnowledgeError } from "./errors.js";
export { KnowledgeConfigSchema, type KnowledgeConfig } from "@lot-agent/core";

export type KnowledgeModule = { source: "remote" } | { source: "local"; service: KnowledgeService };

/** Explicit selection only. Local failures must never query the remote dataset namespace. */
export function createKnowledgeModule(config?: KnowledgeConfig, localService?: KnowledgeService): KnowledgeModule {
  const { source } = KnowledgeConfigSchema.parse(config);
  if (source === "remote") return { source };
  if (!localService) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "内置知识服务尚未装配");
  return { source, service: localService };
}
