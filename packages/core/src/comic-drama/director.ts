import { z } from "zod";
import { COMIC_DIRECTOR_AGENT_ID, COMIC_DIRECTOR_TOOL_NAMES, comicDirectorDefinition } from "../agents/definitions/comic-drama.js";
import { comicDramaClipDraftSchema, type ComicDramaClipDraft } from "./index.js";
import type { ComicGenerationQuote } from "./generation.js";

export { COMIC_DIRECTOR_AGENT_ID, COMIC_DIRECTOR_TOOL_NAMES, comicDirectorDefinition };
export const COMIC_SCRIPT_MAX_CHARS = 20_000;
export const COMIC_SCRIPT_FILE_BYTES = 2 * 1024 * 1024;
export const COMIC_SCRIPT_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const id = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes("\0"));
const optionalText = (max: number) => z.string().trim().max(max).refine(value => !value.includes("\0"));

export const comicDirectorScriptRangeSchema = z.object({
  start: z.number().int().min(0).max(COMIC_SCRIPT_MAX_CHARS),
  end: z.number().int().min(1).max(COMIC_SCRIPT_MAX_CHARS),
}).strict().refine(value => value.end > value.start, "Invalid range");

export const comicDirectorEnhanceTargetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("script_full") }).strict(),
  z.object({
    scope: z.literal("script_excerpt"),
    ranges: z.array(comicDirectorScriptRangeSchema).min(1).max(24),
  }).strict(),
  z.object({
    scope: z.literal("clips"),
    clipIds: z.array(id).min(1).max(24).refine(ids => new Set(ids).size === ids.length, "Clip IDs must be unique"),
  }).strict(),
]);

export const comicDirectorInputSchema = z.object({
  requestId: id,
  expectedRevision: revision,
  mode: z.enum(["outline", "paste", "file"]).default("paste"),
  language: z.enum(["zh", "en", "id"]),
  text: optionalText(COMIC_SCRIPT_MAX_CHARS).default(""),
  action: z.enum(["script", "breakdown", "sequel", "enhance"]).optional(),
  enhance: comicDirectorEnhanceTargetSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "enhance") {
    if (!value.enhance) {
      ctx.addIssue({ code: "custom", path: ["enhance"], message: "Enhancement target is required" });
    }
    return;
  }
  if (!value.text.length) {
    ctx.addIssue({ code: "custom", path: ["text"], message: "Text is required" });
  }
  if (value.enhance !== undefined) {
    ctx.addIssue({ code: "custom", path: ["enhance"], message: "Enhancement target is only allowed for enhance action" });
  }
});

export const comicDirectorModelSchema = z.object({
  script: text(COMIC_SCRIPT_MAX_CHARS),
  characters: z.array(z.object({ name: text(120), description: text(600) }).strict()).max(24),
}).strict();
const part = z.object({
  scene: text(1000), durationMs: z.number().int().min(1000).max(60_000),
  shots: z.array(text(2000)).min(1).max(3),
  lines: z.array(z.object({ speaker: text(120).nullable(), text: text(1000) }).strict()).max(30),
}).strict();
export const comicDirectorBreakdownSchema = z.object({
  clips: z.array(part).min(1).max(24), characters: comicDirectorModelSchema.shape.characters,
}).strict();

export const comicDirectorScriptEnhanceModelSchema = z.object({
  segments: z.array(z.object({
    index: z.number().int().min(0).max(59),
    suggested: text(COMIC_SCRIPT_MAX_CHARS),
    notes: optionalText(400).optional(),
  }).strict()).min(1).max(60),
}).strict();

export const comicDirectorClipEnhanceModelSchema = z.object({
  clips: z.array(z.object({
    index: z.number().int().min(0).max(23).optional(),
    clipId: id.optional(),
    scene: text(1000),
    durationMs: z.number().int().min(1000).max(60_000).optional(),
    notes: optionalText(400).optional(),
    shots: z.array(z.object({
      framingKey: text(64),
      movementKey: text(64),
      description: text(2000),
      durationShare: z.number().int().min(1).max(100),
    }).strict()).min(1).max(3),
    lines: z.array(z.object({
      speaker: optionalText(120).nullable().transform(value => value ? value : null),
      text: text(1000),
      emotionKey: optionalText(64).nullable().transform(value => value ? value : null).optional(),
      speed: z.number().min(0.5).max(2).optional(),
    }).strict()).max(30),
  }).strict()).min(1).max(24),
}).strict();

export const comicDirectorApplySchema = z.object({
  expectedRevision: revision,
  decision: z.enum(["append", "replace", "sequel", "enhance"]).optional(),
  scriptItems: z.array(z.object({
    index: z.number().int().min(0).max(59),
    text: text(COMIC_SCRIPT_MAX_CHARS).optional(),
  }).strict()).min(1).max(60).optional(),
  clipItems: z.array(z.object({
    index: z.number().int().min(0).max(23),
    draft: z.lazy(() => comicDramaClipDraftSchema).optional(),
  }).strict()).min(1).max(24).optional(),
}).strict();

export const comicDirectorDismissSchema = z.object({
  itemIndex: z.number().int().min(0).max(59).optional(),
}).strict();

export const comicDirectorRoleDecisionSchema = z.discriminatedUnion("choice", [
  z.object({ choice: z.literal("existing"), expectedRevision: revision, characterId: id, outfitId: id }).strict(),
  z.object({ choice: z.literal("new"), expectedRevision: revision, outfitName: text(120) }).strict(),
  z.object({ choice: z.literal("skip"), expectedRevision: revision }).strict(),
]);

export type ComicDirectorInput = z.infer<typeof comicDirectorInputSchema>;
export type ComicDirectorEnhanceTarget = z.infer<typeof comicDirectorEnhanceTargetSchema>;
export type ComicDirectorModel = z.infer<typeof comicDirectorModelSchema>;
export type ComicDirectorBreakdown = z.infer<typeof comicDirectorBreakdownSchema>;
export type ComicDirectorScriptEnhanceModel = z.infer<typeof comicDirectorScriptEnhanceModelSchema>;
export type ComicDirectorClipEnhanceModel = z.infer<typeof comicDirectorClipEnhanceModelSchema>;
export type ComicDirectorApplyInput = z.infer<typeof comicDirectorApplySchema>;
export type ComicDirectorDismissInput = z.infer<typeof comicDirectorDismissSchema>;
export type ComicDirectorDecision = ComicDirectorApplyInput["decision"];
export type ComicDirectorRoleDecision = z.infer<typeof comicDirectorRoleDecisionSchema>;
export type ComicDirectorRoleOutcome = { choice: ComicDirectorRoleDecision["choice"]; characterId: string | null; revision: number };
export type ComicDirectorRole = ComicDirectorModel["characters"][number] & { candidates: { id: string; name: string; appearance?: string }[] };
export type ComicEnhancementItemStatus = "pending" | "applied" | "dismissed";
export type ComicScriptEnhancementSegment = {
  index: number;
  start: number;
  end: number;
  original: string;
  suggested: string;
  notes?: string;
  status: ComicEnhancementItemStatus;
  appliedText?: string;
};
export type ComicClipEnhancementSegment = {
  index: number;
  clipId: string;
  ordinal: number;
  baseClipRevision: number;
  original: ComicDramaClipDraft;
  suggested: ComicDramaClipDraft;
  notes?: string;
  status: ComicEnhancementItemStatus;
  appliedDraft?: ComicDramaClipDraft;
};
export type ComicDirectorProposal = {
  id: string; conversationId: string; baseRevision: number; createdAt: string; input: ComicDirectorInput; original: string;
  status: "writing" | "ready" | "unknown" | "failed" | "applied" | "dismissed"; appliedRevision: number | null;
  proposal: {
    script: string;
    roles: ComicDirectorRole[];
    clips?: ComicDramaClipDraft[];
    previousScenes?: string[];
    scriptEnhancements?: ComicScriptEnhancementSegment[];
    clipEnhancements?: ComicClipEnhancementSegment[];
  } | null;
  decision?: ComicDirectorDecision | null; sequelId?: string | null;
  roleDecisions?: Record<string, ComicDirectorRoleOutcome>;
};
export const comicDirectorChatInputSchema = z.object({
  message: text(4000),
  expectedRevision: revision,
  language: z.enum(["zh", "en", "id"]).default("zh"),
}).strict();
export type ComicDirectorChatInput = z.infer<typeof comicDirectorChatInputSchema>;
export type ComicDirectorToolCallSummary = { name: string; summary: string; ok: boolean };
export type ComicDirectorChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolCalls?: ComicDirectorToolCallSummary[];
  proposalId?: string;
  confirmationId?: string;
};
export type ComicDirectorChatResponse = {
  conversationId: string;
  reply: ComicDirectorChatMessage;
  toolResults: Array<ComicDirectorToolCallSummary & { data?: unknown }>;
  seriesUpdated: boolean;
  latestRevision: number;
  proposal?: ComicDirectorProposal;
  quote?: ComicGenerationQuote;
};
export type ComicDirectorQuote = { quote: ComicGenerationQuote; confirmed: boolean };
export type ComicDirectorState = {
  conversationId: string | null;
  proposals: ComicDirectorProposal[];
  quotes?: ComicDirectorQuote[];
  messages?: ComicDirectorChatMessage[];
};
export type ComicScriptImport = { text: string; truncated: boolean };

export type ComicScriptSegmentSlice = {
  index: number;
  start: number;
  end: number;
  original: string;
};

function trimScriptSlice(source: string, rawStart: number, rawEnd: number): { start: number; end: number; original: string } | null {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/.test(source[start]!)) start += 1;
  while (end > start && /\s/.test(source[end - 1]!)) end -= 1;
  if (end <= start) return null;
  return { start, end, original: source.slice(start, end) };
}

function splitScriptSpan(source: string, spanStart: number, spanEnd: number) {
  const span = source.slice(spanStart, spanEnd);
  const blocks: Array<{ start: number; end: number; original: string }> = [];
  let cursor = 0;
  for (const match of span.matchAll(/\r?\n(?:\s*\r?\n)+/g)) {
    const block = trimScriptSlice(source, spanStart + cursor, spanStart + (match.index ?? 0));
    if (block) blocks.push(block);
    cursor = (match.index ?? 0) + match[0].length;
  }
  const tail = trimScriptSlice(source, spanStart + cursor, spanEnd);
  if (tail) blocks.push(tail);
  return blocks;
}

function mergeAdjacentBlocks(
  source: string,
  groups: Array<Array<{ start: number; end: number; original: string }>>,
  maxSegments: number,
) {
  const limit = Math.max(1, maxSegments);
  let total = groups.reduce((sum, group) => sum + group.length, 0);
  while (total > limit) {
    let targetGroupIdx = -1;
    let bestPairIdx = -1;
    let bestSpan = Infinity;
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[g]!;
      if (group.length <= 1) continue;
      for (let i = 0; i < group.length - 1; i += 1) {
        const span = group[i + 1]!.end - group[i]!.start;
        if (span < bestSpan) {
          bestSpan = span;
          targetGroupIdx = g;
          bestPairIdx = i;
        }
      }
    }
    if (targetGroupIdx < 0) return null;
    const group = groups[targetGroupIdx]!;
    const left = group[bestPairIdx]!;
    const right = group[bestPairIdx + 1]!;
    group.splice(bestPairIdx, 2, { start: left.start, end: right.end, original: source.slice(left.start, right.end) });
    total -= 1;
  }
  return groups.flat();
}

export function splitComicScriptSegments(script: string, maxSegments = 24): ComicScriptSegmentSlice[] {
  const blocks = splitScriptSpan(script, 0, script.length);
  if (!blocks.length) return [];
  const merged = mergeAdjacentBlocks(script, [blocks], maxSegments) ?? blocks;
  return merged.map((block, index) => ({ index, ...block }));
}

export function extractComicScriptExcerptSegments(
  script: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
  maxSegments = 24,
): ComicScriptSegmentSlice[] | null {
  if (!ranges.length || ranges.length > maxSegments) return null;
  const trimmedRanges: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end > script.length || range.end <= range.start) {
      return null;
    }
    const trimmed = trimScriptSlice(script, range.start, range.end);
    if (!trimmed) return null;
    trimmedRanges.push({ start: trimmed.start, end: trimmed.end });
  }
  trimmedRanges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < trimmedRanges.length; i += 1) {
    if (trimmedRanges[i - 1]!.end > trimmedRanges[i]!.start) return null;
  }
  const groups = trimmedRanges.map(range => splitScriptSpan(script, range.start, range.end)).filter(group => group.length > 0);
  const merged = mergeAdjacentBlocks(script, groups, maxSegments);
  if (!merged?.length) return null;
  return merged.map((block, index) => ({ index, ...block }));
}

export function applyComicScriptEnhancements(
  originalScript: string,
  segments: ReadonlyArray<Pick<ComicScriptEnhancementSegment, "start" | "end" | "original" | "suggested" | "status" | "appliedText">>,
): string {
  const applied = segments.filter(segment => segment.status === "applied").sort((a, b) => a.start - b.start);
  if (!applied.length) return originalScript;
  let result = "";
  let cursor = 0;
  for (const segment of applied) {
    if (segment.start < cursor || segment.end > originalScript.length || segment.end <= segment.start) {
      throw new Error("INVALID_ENHANCEMENT_RANGE");
    }
    result += originalScript.slice(cursor, segment.start);
    result += segment.appliedText ?? segment.suggested;
    cursor = segment.end;
  }
  result += originalScript.slice(cursor);
  return result;
}

export function normalizeShotDurationShares(shares: readonly number[]): number[] {
  if (!shares.length) return [];
  if (shares.length === 1) return [100];
  if (shares.every(value => Number.isInteger(value) && value >= 1) && shares.reduce((sum, value) => sum + value, 0) === 100) {
    return [...shares];
  }
  const sanitized = shares.map(value => (Number.isFinite(value) && value > 0 ? value : 1));
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  const raw = sanitized.map(value => (value / total) * 100);
  const result = raw.map(value => Math.max(1, Math.floor(value)));
  let currentSum = result.reduce((sum, value) => sum + value, 0);
  if (currentSum < 100) {
    const order = raw.map((value, idx) => ({ idx, frac: value - result[idx]! })).sort((a, b) => b.frac - a.frac);
    for (let i = 0; currentSum < 100; i = (i + 1) % order.length) {
      result[order[i]!.idx]! += 1;
      currentSum += 1;
    }
  } else if (currentSum > 100) {
    while (currentSum > 100) {
      let maxIdx = -1;
      for (let i = 0; i < result.length; i += 1) {
        if (result[i]! > 1 && (maxIdx < 0 || result[i]! > result[maxIdx]!)) maxIdx = i;
      }
      if (maxIdx < 0) break;
      result[maxIdx]! -= 1;
      currentSum -= 1;
    }
  }
  return result;
}

export function rebalanceShotDurationShares<T extends { durationShare: number }>(
  shots: readonly T[],
  changedIndex: number,
  nextShare: number,
): T[] {
  if (shots.length <= 1) return shots.map(shot => ({ ...shot, durationShare: 100 }));
  const maxAllowed = 100 - (shots.length - 1);
  const clamped = Math.min(maxAllowed, Math.max(1, Math.round(nextShare)));
  const remaining = 100 - clamped;
  const others = shots.filter((_, idx) => idx !== changedIndex);
  const otherTotal = others.reduce((sum, shot) => sum + shot.durationShare, 0) || others.length;
  let assigned = 0;
  let seen = 0;
  return shots.map((shot, idx) => {
    if (idx === changedIndex) return { ...shot, durationShare: clamped };
    seen += 1;
    if (seen === others.length) return { ...shot, durationShare: Math.max(1, remaining - assigned) };
    const share = Math.max(
      1,
      Math.min(remaining - (others.length - seen) - assigned, Math.round((shot.durationShare / otherTotal) * remaining)),
    );
    assigned += share;
    return { ...shot, durationShare: share };
  });
}
