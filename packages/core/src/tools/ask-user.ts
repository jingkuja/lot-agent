import type { Tool, ToolResult } from "../types/index.js";

/** Placeholder tool result recorded while the user has not answered yet —
 * keeps the tool_call → tool_result pairing valid for provider formats. */
export const ASK_USER_WAITING =
  "[Question sent; waiting for the user reply in the next message]";

/** Whether the agent's tool whitelist grants ask_user. undefined = all tools. */
export function hasAskUserTool(names?: string[]): boolean {
  if (!names) return true;
  return names.includes("ask_user");
}

/** Strategy block injected into the system prompt of ask_user-capable agents. */
export const ASK_USER_POLICY_PROMPT = `[Clarification policy]
Use ask_user when essential information is missing.
1. Ask one concrete, directly answerable question at a time. question contains only the question itself.
2. Whenever candidate answers can be enumerated, put 2–6 short choices in options. Never embed choices or an example list inside question; that would make them unclickable. Free text remains available.
3. For questions allowing multiple answers (comparison dimensions, audiences or channels), provide options and multiSelect: true.
4. Do not ask about reasonably inferable details or interrupt the user with repeated questions.
5. Calling ask_user ends the turn. The user's reply arrives in the next message.
6. Write questions and options in the user's language, not necessarily English.

Correct example:
{"question":"Which aspects of grapes and bananas should I compare?","options":["Nutrition","Health benefits","Sports fuel","Price and season","Suitable audiences"],"multiSelect":true}
Incorrect: listing candidates inside question without options/multiSelect.`;

interface AskUserInput {
  question?: string;
  options?: string[];
  allowFreeText?: boolean;
  multiSelect?: boolean;
}

export const askUserTool: Tool = {
  name: "ask_user",
  effect: "interaction",
  description:
    "Ask one clarification question and wait for the answer when essential information is missing. Put enumerable choices in options, never inside question. Set multiSelect: true when multiple choices are allowed. This ends the turn; the answer arrives in the next user message. Use the user's language for question and option labels.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Required question; ask only one at a time.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
        description:
          "2–6 short clickable choices. Required whenever candidate answers can be enumerated. Put candidates only here, not inside question.",
      },
      allowFreeText: {
        type: "boolean",
        description: "Allow free-text answers (default true).",
      },
      multiSelect: {
        type: "boolean",
        description:
          "Allow multiple choices (default false). Selected answers are submitted together, separated by the ideographic comma delimiter.",
      },
    },
    required: ["question"],
  },
  endsTurn: true,
  async execute(input): Promise<ToolResult> {
    const { question } = (input as AskUserInput) ?? {};
    if (!question?.trim()) {
      return {
        content: "ask_user requires the question field.",
        isError: true,
        errorKind: "validation",
      };
    }
    return { content: ASK_USER_WAITING };
  },
};
