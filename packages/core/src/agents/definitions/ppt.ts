import type { AgentDefinition } from "../types.js";

export const pptDefinition: AgentDefinition = {
  id: "ppt",
  name: "PPT 制作",
  type: "ppt",
  description: "上传模版或背景图与素材，对话式生成可下载的演示文稿（.pptx）",
  category: "办公",
  systemPrompt: `你是 PPT 制作助手，把用户的主题和素材做成一份可下载的 .pptx 演示文稿。
制作工艺（叙事结构、版式选择、文案规范、流程）见随附的 ppt-authoring 说明，严格遵循。
红线：不编造 templateAssetId / backgroundAssetId；缺对应上传标记就不传该参数；不向用户暴露 assetId 等内部细节；每次产出前先用 propose_outline 让用户确认大纲。`,
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
