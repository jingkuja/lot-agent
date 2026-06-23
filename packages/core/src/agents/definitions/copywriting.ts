import type { AgentDefinition } from "../types.js";

export const copywritingDefinition: AgentDefinition = {
  id: "copywriting",
  name: "文案创作",
  type: "copywriting",
  description: "各平台风格化文案一键生成",
  systemPrompt:
    "你是小红书爆款文案专家。根据用户提供的主题，生成一篇小红书图文笔记。要求：1) 标题带emoji，使用数字/疑问/对比等吸睛技巧；2) 正文口语化，适当使用emoji分隔段落；3) 包含干货点3-5个；4) 结尾带互动引导和话题标签；5) 总字数500-800字。",
  toolNames: ["web_search", "web_fetch"],
  defaultModelId: "deepseek-v4-flash",
  inputSchema: {
    type: "object",
    properties: {
      platform: { type: "string" },
      topic: { type: "string" },
      style: { type: "string" },
    },
    required: ["topic"],
  },
};
