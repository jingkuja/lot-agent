import { z } from "zod";

export const MarketingDraftSchema = z.object({
  topic: z.string().max(800).default(""),
  copyMode: z.enum(["generate", "rewrite"]).default("generate"),
  reference: z.string().max(6000).default(""),
  script: z.string().max(2000).default(""),
  durationSec: z.union([z.literal(30), z.literal(45), z.literal(60)]).default(30),
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

/** Split at phrase boundaries. Segment times are integers accepted by Kling. */
export function planMarketingSegments(script: string, durationSec: number): MarketingSegment[] {
  if (![30, 45, 60].includes(durationSec) || !script.trim()) throw new Error("请填写文案并选择 30、45 或 60 秒。");
  const units = speechUnits(script);
  if (units > durationSec * 4.5) throw new Error("文案过长，请精简文案或增加视频时长。");
  // Preserve every character, including whitespace and punctuation. Long
  // sentences may be split at a comma, space, or ultimately a character edge.
  const count = durationSec / 15;
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
  return parts.map((text, index) => ({ index, script: text, durationSec: 15 }));
}
