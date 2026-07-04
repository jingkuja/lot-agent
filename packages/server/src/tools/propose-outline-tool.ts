import type { Tool, ToolResult } from "@lot-agent/core";
import { validateSlides } from "../ppt/validation.js";
import type { PptSlide } from "../ppt/renderer.js";

const SLIDE_ITEMS = {
  type: "object",
  properties: {
    layout: { type: "string", enum: ["cover", "agenda", "section", "content", "keypoints", "stats", "compare", "timeline", "quote", "closing"] },
    title: { type: "string" },
    subtitle: { type: "string" },
    bullets: { type: "array", items: { type: "string" } },
    items: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, desc: { type: "string" } }, required: ["label"] } },
    left: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "bullets"] },
    right: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "bullets"] },
    quote: { type: "object", properties: { text: { type: "string" }, author: { type: "string" } }, required: ["text"] },
    notes: { type: "string" },
  },
  required: ["layout", "title"],
};

/** propose_outline — 把结构化大纲展示给用户确认；endsTurn，本轮结束等回复。不产文件。 */
export const proposeOutlineTool: Tool = {
  name: "propose_outline",
  description:
    "在生成 PPT 前，把逐页大纲（每页 layout + 标题 + 要点/数据/对比等）展示给用户确认或修改。" +
    "调用后本轮结束，用户会确认或提出修改意见。slides 结构与 generate_ppt 完全一致。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "演示文稿标题" },
      slides: { type: "array", description: "逐页大纲，结构同 generate_ppt", items: SLIDE_ITEMS },
    },
    required: ["title", "slides"],
  },
  endsTurn: true,
  async execute(input): Promise<ToolResult> {
    const { slides } = (input as { slides?: PptSlide[] }) ?? {};
    const err = validateSlides(slides);
    if (err) return { content: `propose_outline 校验失败：${err}`, isError: true, errorKind: "validation" };
    return { content: "[大纲已展示给用户，等待确认或修改意见；用户的回复将作为下一条消息出现]" };
  },
};
