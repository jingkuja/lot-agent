import type { ChatParams } from "../types/index.js";

export type AgentType = "general" | "copywriting" | "image" | "video" | "ppt" | "contract";

export interface AgentDefinition {
  id: string;
  name: string;
  type: AgentType;
  description: string;
  category?: string;          // 市场分组用,如 创作 / 办公 / 审核
  hidden?: boolean;           // 保持注册(旧会话仍可解析)但不在 Agent 中心展示/安装
  systemPrompt: string;
  toolNames: string[];        // allowed tool whitelist; empty array = no tools
  defaultModelId: string;     // e.g. "deepseek-v4-flash" (matches a configured model id)
  inputSchema?: Record<string, unknown>;
  modelParams?: ChatParams;
}

export interface AgentRegistry {
  register(def: AgentDefinition): void;
  get(id: string): AgentDefinition | undefined;
  list(): AgentDefinition[];
}
