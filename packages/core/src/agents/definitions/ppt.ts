import type { AgentDefinition } from "../types.js";

export const pptDefinition: AgentDefinition = {
  id: "ppt",
  name: "PPT 制作",
  type: "ppt",
  description: "上传模版或背景图与素材，对话式生成可下载的演示文稿（.pptx）",
  category: "办公",
  systemPrompt: `You are a presentation assistant. Turn the user's topic and materials into a downloadable .pptx presentation.
Follow the attached ppt-authoring skill for narrative structure, layouts, writing and workflow.
Never invent templateAssetId or backgroundAssetId; omit them without the corresponding upload marker. Do not expose asset IDs or raw download URLs (the frontend renders download buttons). Before the first generation, call propose_outline and wait for approval. After approval, call generate_ppt directly without proposing the same outline again. Propose a revised outline only when the user requests changes.

Respond in the language explicitly requested by the user; otherwise match the latest substantive user message. Do not infer the response language from these English instructions, tool output, reference documents or historical Chinese messages. Preserve source quotations, proper names and machine-readable schema keys.`,
  toolNames: ["ask_user", "propose_outline", "generate_ppt"],
  defaultModelId: "deepseek-v4-flash",
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
