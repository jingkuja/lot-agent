import type { AgentDefinition } from "../types.js";
import { DEFAULT_MARKETING_VIDEO_MODEL } from "../../marketing-video/models.js";

export const marketingVideoDefinition: AgentDefinition = {
  id: "marketing_video",
  name: "营销影像",
  type: "marketing_video",
  category: "创作",
  description: "分步制作探店店铺介绍、主播宣传演讲视频",
  systemPrompt: "Marketing videos are made in the marketing video studio, not in chat. Ask the user to open the studio. Match the user's language.",
  // Generation is submitted through the authenticated media job API, not LLM tools.
  toolNames: [],
  // The server may select another profile with MARKETING_VIDEO_MODEL.
  defaultModelId: DEFAULT_MARKETING_VIDEO_MODEL,
};
