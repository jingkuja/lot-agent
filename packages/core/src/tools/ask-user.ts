import type { Tool, ToolResult } from "../types/index.js";

/** Placeholder tool result recorded while the user has not answered yet —
 * keeps the tool_call → tool_result pairing valid for provider formats. */
export const ASK_USER_WAITING =
  "[已向用户提问，等待回复；用户的回答将作为下一条消息出现]";

/** Whether the agent's tool whitelist grants ask_user. undefined = all tools. */
export function hasAskUserTool(names?: string[]): boolean {
  if (!names) return true;
  return names.includes("ask_user");
}

/** Strategy block injected into the system prompt of ask_user-capable agents. */
export const ASK_USER_POLICY_PROMPT = `[向用户提问策略]
当缺少继续工作所必需的关键信息时，调用 ask_user 工具向用户提问：
1. 一次只问一个问题；问题要具体、可直接回答。
2. 能列出常见答案时提供 options 选项（2-6 个短语），用户也可以自由输入。
3. 当问题允许同时选择多个答案（如受众、发布平台）时设置 multiSelect: true。
4. 能合理推断的信息不要问，避免连环提问打断用户。
5. question 支持 Markdown（列表、加粗等），较长的确认内容用换行列表呈现。
6. 调用 ask_user 后本轮立即结束，用户的回答会作为下一条消息出现。`;

interface AskUserInput {
  question?: string;
  options?: string[];
  allowFreeText?: boolean;
  multiSelect?: boolean;
}

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "向用户提出一个澄清问题并等待回答。当缺少继续任务所必需的信息时使用。" +
    "可附带 options 供用户点选。调用后本轮结束，用户的回答会作为下一条消息出现。",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "要问用户的问题（必填，一次只问一个）",
      },
      options: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
        description: "可选的快捷选项（2-6 个短语），用户点选后即为回答",
      },
      allowFreeText: {
        type: "boolean",
        description: "是否允许自由输入（默认 true）",
      },
      multiSelect: {
        type: "boolean",
        description:
          "是否允许多选（默认 false）。为 true 时用户可勾选多个选项一并提交，回答以「、」分隔",
      },
    },
    required: ["question"],
  },
  endsTurn: true,
  async execute(input): Promise<ToolResult> {
    const { question } = (input as AskUserInput) ?? {};
    if (!question?.trim()) {
      return {
        content: "ask_user 调用缺少 question 字段。",
        isError: true,
        errorKind: "validation",
      };
    }
    return { content: ASK_USER_WAITING };
  },
};
