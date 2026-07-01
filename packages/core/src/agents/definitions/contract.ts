import type { AgentDefinition } from "../types.js";

export const contractDefinition: AgentDefinition = {
  id: "contract",
  name: "合同审核",
  type: "contract",
  description: "上传合同,自动识别风险条款并给出审核意见",
  category: "审核",
  systemPrompt: "（占位）合同审核 Agent,后续接入文档解析与风险审查能力。",
  toolNames: [],
  defaultModelId: "deepseek-v4-flash",
  inputSchema: {
    type: "object",
    properties: {
      document: { type: "string" },
    },
    required: ["document"],
  },
};
