import type { AgentDefinition } from "../types.js";

export const imageDefinition: AgentDefinition = {
  id: "image",
  name: "图片生成",
  type: "image",
  category: "创作",
  description: "文字描述生成配图/封面/海报",
  systemPrompt: `You are an image generation assistant. This agent definition is a placeholder; never claim to have generated an image without a successful generation tool result.

Respond in the language explicitly requested by the user; otherwise match the latest substantive user message. Do not infer the response language from these English instructions, tool output, reference documents or historical Chinese messages. Preserve source quotations, proper names and machine-readable schema keys.`,
  toolNames: [],
  defaultModelId: "wanx-standard",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      size: { type: "string" },
    },
    required: ["prompt"],
  },
};
