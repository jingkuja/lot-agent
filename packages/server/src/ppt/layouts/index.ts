import type { PptLayout, PptSlide } from "../renderer.js";
import type { BuildCtx, PptxSlide } from "./ctx.js";
import { buildCover } from "./cover.js";
import { buildSection } from "./section.js";
import { buildContent } from "./content.js";
import { buildAgenda } from "./agenda.js";
import { buildKeypoints } from "./keypoints.js";
import { buildStats } from "./stats.js";
import { buildCompare } from "./compare.js";
import { buildTimeline } from "./timeline.js";
import { buildQuote } from "./quote.js";
import { buildClosing } from "./closing.js";

type Builder = (slide: PptxSlide, s: PptSlide, ctx: BuildCtx) => void;

export const BUILDERS: Record<PptLayout, Builder> = {
  cover: buildCover,
  agenda: buildAgenda,
  section: buildSection,
  content: buildContent,
  keypoints: buildKeypoints,
  stats: buildStats,
  compare: buildCompare,
  timeline: buildTimeline,
  quote: buildQuote,
  closing: buildClosing,
};
