import type { AgentDefinition } from "../types.js";

export const copywritingDefinition: AgentDefinition = {
  id: "copywriting",
  name: "文案创作",
  type: "copywriting",
  category: "创作",
  // 业务流程尚未实现,暂时从 Agent 中心屏蔽;已有会话仍可通过注册表解析。
  hidden: true,
  description: "各平台风格化文案一键生成",
  systemPrompt: `You write compelling Xiaohongshu posts from the user's topic. Use an engaging title with an emoji and a useful number, question or comparison. Write conversational paragraphs with occasional emoji separators, 3–5 substantive takeaways, and a closing invitation to interact plus relevant hashtags. Aim for 500–800 characters, adapted to the requested language.

Respond in the language explicitly requested by the user; otherwise match the latest substantive user message. Do not infer the response language from these English instructions, tool output, reference documents or historical Chinese messages. Preserve source quotations, proper names and machine-readable schema keys.`,
  toolNames: ["web_search", "web_fetch"],
  defaultModelId: "deepseek-v4.1-flash",
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
