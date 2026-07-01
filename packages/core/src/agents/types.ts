export type AgentType = "general" | "copywriting" | "image" | "video" | "ppt" | "contract";

export interface AgentDefinition {
  id: string;
  name: string;
  type: AgentType;
  description: string;
  category?: string;          // 市场分组用,如 创作 / 办公 / 审核
  systemPrompt: string;
  toolNames: string[];        // allowed tool whitelist; empty array = no tools
  defaultModelId: string;     // e.g. "deepseek-v4-flash" (matches a configured model id)
  inputSchema?: Record<string, unknown>;
}

export interface AgentRegistry {
  register(def: AgentDefinition): void;
  get(id: string): AgentDefinition | undefined;
  list(): AgentDefinition[];
}
