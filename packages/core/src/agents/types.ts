export type AgentType = "general" | "copywriting" | "image" | "video";

export interface AgentDefinition {
  id: string;
  name: string;
  type: AgentType;
  description: string;
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
