import type { AgentDefinition } from "../types.js";

export const videoDefinition: AgentDefinition = {
  id: "video",
  name: "视频生成",
  type: "video",
  category: "创作",
  description: "脚本/描述生成短视频",
  systemPrompt: `You are a video generation assistant. This agent definition is a placeholder; never claim to have generated a video without a successful generation tool result.

Respond in the language explicitly requested by the user; otherwise match the latest substantive user message. Do not infer the response language from these English instructions, tool output, reference documents or historical Chinese messages. Preserve source quotations, proper names and machine-readable schema keys.`,
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
