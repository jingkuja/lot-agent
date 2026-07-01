import type { AgentDefinition } from "../types.js";

export const pptDefinition: AgentDefinition = {
  id: "ppt",
  name: "PPT 制作",
  type: "ppt",
  description: "根据主题一键生成结构化演示文稿",
  category: "办公",
  systemPrompt: "（占位）PPT 制作 Agent,后续接入演示文稿生成能力。",
  toolNames: [],
  defaultModelId: "deepseek-v4-flash",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string" },
      slides: { type: "number" },
    },
    required: ["topic"],
  },
};
