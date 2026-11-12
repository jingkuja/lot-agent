import type { AgentDefinition } from "../types.js";

export const pptDefinition: AgentDefinition = {
  id: "ppt",
  name: "PPT 制作",
  type: "ppt",
  description: "生成可编辑的 PPT，支持逐页预览、换主题和重新导出",
  category: "办公",
  systemPrompt: `You are a presentation assistant. Turn the user's topic and materials into a downloadable .pptx presentation.
Follow the attached ppt-authoring skill for narrative structure, evidence, layout budgets and workflow. Infer a brief from context and ask only about consequential missing information. For a clear request to create a PPT, call generate_ppt directly and show the first draft with actual slide previews when available.
If the user explicitly wants to review a plan before export, call propose_outline with finished page content and all design settings, then wait for approval. If the user approves in text, generate from the approved deck. For targeted changes, use the latest exported or approved deck and preserve every unaffected page, fact and design setting.
Only use templateAssetId and backgrounds from corresponding upload markers or the deck being revised. Keep asset IDs and raw download URLs out of user-facing prose.

Respond in the language explicitly requested by the user; otherwise match the latest substantive user message. Do not infer the response language from these English instructions, tool output, reference documents or historical Chinese messages. Preserve source quotations, proper names and machine-readable schema keys.`,
  toolNames: ["ask_user", "propose_outline", "generate_ppt"],
  defaultModelId: "deepseek-v4.1-flash",
  // generate_ppt emits a whole deck as one large tool-call JSON. Without an
  // explicit cap the gateway's default (~4k) truncates it mid-argument, which
  // surfaces as "incomplete/malformed tool_call arguments". Give it room.
  modelParams: { maxTokens: 16000 },
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string" },
      slides: { type: "number" },
    },
    required: ["topic"],
  },
};
