import type { PptLayout, PptSlide } from "../renderer.js";
import type { BuildCtx, PptxSlide } from "./ctx.js";
import { buildCover } from "./cover.js";
import { buildSection } from "./section.js";
import { buildContent } from "./content.js";

type Builder = (slide: PptxSlide, s: PptSlide, ctx: BuildCtx) => void;

// Task 4 会替换 agenda/keypoints/stats/compare/timeline/quote/closing 为专用 builder
export const BUILDERS: Record<PptLayout, Builder> = {
  cover: buildCover,
  section: buildSection,
  content: buildContent,
  agenda: buildContent,
  keypoints: buildContent,
  stats: buildContent,
  compare: buildContent,
  timeline: buildContent,
  quote: buildSection,
  closing: buildSection,
};
