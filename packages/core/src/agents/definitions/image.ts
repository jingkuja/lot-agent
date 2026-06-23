import type { AgentDefinition } from "../types.js";

export const imageDefinition: AgentDefinition = {
  id: "image",
  name: "图片生成",
  type: "image",
  description: "文字描述生成配图/封面/海报",
  systemPrompt: "（占位）图片生成 Agent，后续接入图像生成能力。",
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
