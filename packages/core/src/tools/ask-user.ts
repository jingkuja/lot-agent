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
1. 一次只问一个问题；question 只写一句话的问题本身，要具体、可直接回答。
2. 只要问题存在可枚举的候选答案，就必须把每个候选项放进 options 数组（2-6 个短语），用户仍可自由输入。禁止把候选项写进 question——不要用「例如：」加列表在 question 里罗列答案，那样会导致选项无法点选。
3. 当问题允许同时选择多个答案（如对比维度、受众、发布平台）时，必须同时设置 multiSelect: true 且提供 options。
4. 能合理推断的信息不要问，避免连环提问打断用户。
5. 调用 ask_user 后本轮立即结束，用户的回答会作为下一条消息出现。

正例——想了解「葡萄和香蕉对比哪些方面」时这样调用：
{"question":"你想对比葡萄和香蕉的哪些方面？","options":["营养价值","健康益处","运动补给","价格与季节","适合人群"],"multiSelect":true}
反例（禁止）：把选项塞进 question，如 {"question":"...例如：\\n- 营养价值\\n- 健康益处"}，且不给 options/multiSelect。`;

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
    "凡是有可枚举候选答案的问题，都要用 options 数组列出选项（不要把选项写进 question）；" +
    "允许多选时再加 multiSelect: true。调用后本轮结束，用户的回答会作为下一条消息出现。",
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
        description:
          "可选的快捷选项（2-6 个短语），用户点选后即为回答。问题存在可枚举候选答案时必须提供，且候选项只放这里、不要写进 question",
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
