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
    "Before generating a presentation, show the per-slide outline (layout, title, points, data or comparisons) for user approval or revision. This ends the turn. slides has the same structure as generate_ppt.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Presentation title." },
      slides: { type: "array", description: "Per-slide outline, using the generate_ppt schema.", items: SLIDE_ITEMS },
    },
    required: ["title", "slides"],
  },
  endsTurn: true,
  async execute(input): Promise<ToolResult> {
    const { slides } = (input as { slides?: PptSlide[] }) ?? {};
    const err = validateSlides(slides);
    if (err) return { content: `propose_outline validation failed: ${err}`, isError: true, errorKind: "validation" };
    return { content: "[Outline shown; waiting for approval or revisions in the next user message]" };
  },
};
