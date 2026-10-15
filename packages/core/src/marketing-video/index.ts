import { z } from "zod";

export const MARKETING_COPY_MODEL = "kimi-k3";
export const MarketingShotSchema = z.object({
  // Existing saved boards predate per-shot timing and used 15-second clips.
  durationSec: z.number().int().min(4).max(15).default(15),
  script: z.string().max(600),
  visual: z.string().max(600),
  action: z.string().max(400),
  camera: z.string().max(400),
}).strict();
export const MarketingStoryboardSchema = z.array(MarketingShotSchema).max(15);
export type MarketingShot = z.infer<typeof MarketingShotSchema>;

export const MarketingCreationSchema = z.object({
  shots: MarketingStoryboardSchema,
  publishTitle: z.string().trim().min(1).max(100),
  tags: z.string().max(160),
  analysis: z.string().trim().min(1).max(2000),
}).strict();

export const MarketingDraftSchema = z.object({
  topic: z.string().max(800).default(""),
  copyMode: z.enum(["generate", "rewrite"]).default("generate"),
  reference: z.string().max(6000).default(""),
  script: z.string().max(2000).default(""),
  durationSec: z.number().int().min(15).max(60).default(30),
  mode: z.enum(["avatar", "recorded"]).default("avatar"),
  background: z.string().max(600).default("简约演播室"),
  voice: z.string().max(100).default("自然旁白"),
  ratio: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  quality: z.enum(["720p", "1080p"]).default("720p"),
  subtitles: z.boolean().default(true),
  musicVolume: z.number().min(0).max(0.5).default(0.12),
  assets: z.object({
    portrait: z.string().uuid().optional(), background: z.string().uuid().optional(),
    voice: z.string().uuid().optional(), video: z.string().uuid().optional(),
    music: z.string().uuid().optional(), cover: z.string().uuid().optional(),
  }).strict().default({}),
  storyboard: MarketingStoryboardSchema.default([]),
  publishTitle: z.string().max(100).default(""),
  tags: z.string().max(160).default(""),
}).strict();
export type MarketingDraft = z.infer<typeof MarketingDraftSchema>;
export const MarketingReviewSchema = z.object({
  verdict: z.enum(["pass", "suspect", "reject"]),
  issues: z.array(z.object({ text: z.string().max(500), reason: z.string().max(500), suggestion: z.string().max(500) }).strict()).max(20),
}).strict();
export type MarketingReview = z.infer<typeof MarketingReviewSchema>;
export interface MarketingSegment { index: number; script: string; durationSec: number; }
export interface MarketingProject {
  referenceAnalysis?: { id: string; acceptedRevision: number; evidenceIds: string[] };
  id: string; version: number; draft: MarketingDraft; updatedAt: string;
  review: MarketingReview | null; reviewedScript: string | null;
  taskId: string | null; status: string; progress: number; stage?: string;
  error?: string; output?: { assetIds: string[]; assets: { url: string; mime: string }[] };
  knowledgeItemId: string | null;
  knowledgeVersion?: number | null;
}
/** A store is owner-scoped even for worker reads; infrastructure lives in server. */
export interface MarketingProjectStore {
  get(owner: string, id: string): Promise<MarketingProject | null>;
  list(owner: string): Promise<MarketingProject[]>;
  save(owner: string, id: string, version: number, draft: MarketingDraft): Promise<MarketingProject>;
}

/** Rough copy budget only. Actual narration and lip alignment need an audio provider. */
export function speechUnits(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff]/g)?.length ?? 0;
  const words = text.replace(/[\u3400-\u9fff\u3040-\u30ff]/g, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return cjk + words * 2;
}

/** The selected duration is a target; allow up to five extra seconds for pacing. */
export const marketingMaxDuration = (target: number) => Math.min(65, target + 5);
export const isMarketingDurationValid = (target: number, actual: number) => Number.isInteger(target) && target >= 15 && target <= 60
  && Number.isInteger(actual) && actual >= target && actual <= marketingMaxDuration(target);

/** Keep the AI's valid timing, or apportion integer seconds by its pacing
 * weights, bounded by narration length and the model's 4–15 second range. */
export function allocateShotDurations(shots: { script: string; durationSec?: number }[], target: number): number[] {
  const maximum = marketingMaxDuration(target);
  if (!isMarketingDurationValid(target, target) || !shots.length || shots.length > 15
    || shots.length * 4 > maximum || shots.length * 15 < target) throw new Error("分镜数量与视频时长不一致，请重新生成分镜。");
  const minimum = shots.map(shot => Math.max(4, Math.ceil(speechUnits(shot.script) / 4.5)));
  const minimumTotal = minimum.reduce((a, b) => a + b, 0);
  if (minimum.some(n => n > 15) || minimumTotal > maximum) throw new Error("文案过长，请精简文案或增加视频时长。");
  const requested = shots.map(shot => shot.durationSec ?? 0);
  if (requested.every((n, i) => Number.isInteger(n) && n >= minimum[i] && n <= 15) && isMarketingDurationValid(target, requested.reduce((a, b) => a + b, 0))) return requested;
  const total = Math.max(target, minimumTotal);
  const weights = shots.map(shot => Math.max(1, shot.durationSec ?? speechUnits(shot.script)));
  const result = [...minimum];
  for (let remaining = total - result.reduce((a, b) => a + b, 0); remaining > 0; remaining--) {
    let best = -1;
    for (let i = 0; i < result.length; i++) if (result[i] < 15 && (best < 0 || weights[i] / (result[i] + 1) > weights[best] / (result[best] + 1))) best = i;
    result[best]++;
  }
  return result;
}

export function timeMarketingStoryboard(shots: MarketingShot[], total: number): MarketingShot[] {
  const durations = allocateShotDurations(shots, total);
  return shots.map((shot, index) => ({ ...shot, durationSec: durations[index] }));
}

/** Split at phrase boundaries. Segment times are integers accepted by Kling. */
export function planMarketingSegments(script: string, durationSec: number): MarketingSegment[] {
  if (!Number.isInteger(durationSec) || durationSec < 15 || durationSec > 60 || !script.trim()) throw new Error("请填写文案并选择 15–60 秒的整片时长。");
  const units = speechUnits(script);
  if (units > marketingMaxDuration(durationSec) * 4.5) throw new Error("文案过长，请精简文案或增加视频时长。");
  // Preserve every character, including whitespace and punctuation. Long
  // sentences may be split at a comma, space, or ultimately a character edge.
  const count = Math.max(Math.ceil(durationSec / 15), Math.min(Math.ceil(durationSec / 8), Math.floor(units / 4)));
  if (units < count * 4) throw new Error("文案过短，请补充内容。");
  const chars = Array.from(script.trim());
  if (chars.length < count) throw new Error("文案过短，请补充内容。");
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < count - 1; i++) {
    const remaining = chars.length - start;
    const target = start + Math.round(remaining / (count - i));
    const lower = start + Math.max(1, Math.floor(remaining / (count - i) * 0.65));
    const upper = Math.min(chars.length - (count - i - 1), start + Math.ceil(remaining / (count - i) * 1.2));
    let end = target;
    const candidates = Array.from({ length: upper - lower + 1 }, (_, n) => lower + n)
      .filter((n) => /[。！？.!?；;，,\s]/u.test(chars[n - 1]));
    if (candidates.length) end = candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    parts.push(chars.slice(start, end).join("")); start = end;
  }
  parts.push(chars.slice(start).join(""));
  if (parts.some((text) => speechUnits(text) === 0)) throw new Error("文案过短，请补充内容。");
  if (parts.some((text) => speechUnits(text) > 15 * 4.5)) throw new Error("部分段落过长，请缩短句子后重试。");
  const durations = allocateShotDurations(parts.map(script => ({ script })), durationSec);
  return parts.map((text, index) => ({ index, script: text, durationSec: durations[index] }));
}

/** Narration edits in the storyboard are also the project's editable copy. */
export const storyboardScript = (shots: Pick<MarketingShot, "script">[]) => shots.map(shot => shot.script.trim()).join("\n");
export function marketingReviewText(draft: MarketingDraft): string {
  const base = [draft.script, draft.publishTitle, draft.tags].join("\n");
  return draft.storyboard?.length ? `${base}\n${draft.storyboard.map(shot => [shot.visual, shot.action, shot.camera].join("\n")).join("\n")}` : base;
}

/** Saved shot boundaries are authoritative; never re-split edited narration. */
export function resolveMarketingSegments(draft: MarketingDraft): MarketingSegment[] {
  if (!draft.storyboard?.length) return planMarketingSegments(draft.script, draft.durationSec);
  const durations = draft.storyboard.map(shot => shot.durationSec ?? 15);
  if (durations.some(n => !Number.isInteger(n) || n < 4 || n > 15) || !isMarketingDurationValid(draft.durationSec, durations.reduce((a, b) => a + b, 0))) throw new Error("分镜总时长不能短于目标时长，最多可多 5 秒，且不超过 65 秒。");
  if (storyboardScript(draft.storyboard) !== draft.script.trim()) throw new Error("分镜口播与文案不一致，请重新生成分镜。");
  return draft.storyboard.map((shot, index) => {
    if (![shot.script, shot.visual, shot.action, shot.camera].every(value => value.trim())) throw new Error("请补全每段分镜的口播、画面、动作和镜头信息。");
    if (!speechUnits(shot.script)) throw new Error("文案过短，请补充内容。");
    if (speechUnits(shot.script) > durations[index] * 4.5) throw new Error("部分段落过长，请缩短句子后重试。");
    return { index, script: shot.script, durationSec: durations[index] };
  });
}

export * from "./source.js";
