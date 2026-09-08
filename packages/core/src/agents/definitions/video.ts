import type { AgentDefinition } from "../types.js";

export const videoDefinition: AgentDefinition = {
  id: "video",
  name: "视频生成",
  type: "video",
  category: "创作",
  description: "脚本/描述生成短视频",
  systemPrompt: "（占位）视频生成 Agent，后续接入视频生成能力。",
  toolNames: [],
  defaultModelId: "kling-video-v3-omni",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string" },
    },
    required: ["script"],
  },
};
