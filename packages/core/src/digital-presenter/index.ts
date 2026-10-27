import { z } from "zod";
import { marketingCaptionLinesMatch, MarketingCaptionsSchema, marketingShotCaption, type MarketingCaption, type MarketingCaptions } from "../marketing-video/index.js";

/** Vendor models behind the gateway's OpenAI-compatible `/videos` endpoint. */
export const PRESENTER_IMAGE_MODEL = "wan2.2-s2v";
export const PRESENTER_VIDEO_MODEL = "videoretalk";
export const PRESENTER_COPY_MODEL = "kimi-k3";
export const PRESENTER_INPUT_VERSION = 1;

/** wan2.2-s2v fails audio of 20 seconds or more; keep a margin for speech pace. */
export const PRESENTER_SEGMENT_MAX_MS = 19_500;
/** Text is split so a segment is expected to stay under this at speed 1. */
export const PRESENTER_SEGMENT_TARGET_SEC = 12;
/** A single sentence longer than this must be split by the user. */
export const PRESENTER_SENTENCE_MAX_SEC = 15;
export const PRESENTER_MAX_SEGMENTS = 12;
/** VideoRetalk takes 2–120 seconds of audio; the master adds short pauses between segments. */
export const PRESENTER_RETALK_MIN_MS = 2_200;
export const PRESENTER_RETALK_MAX_MS = 118_000;
/** Image mode: total length of all segments. */
export const PRESENTER_IMAGE_MAX_MS = 90_000;
/** Silence between segment takes in the video-mode master and the final cut. */
export const PRESENTER_SEGMENT_GAP_MS = 250;

const uuid = z.string().uuid();

export const PresenterVoiceSchema = z.object({
  /** Digital twin voice item; synthesis needs its cloned voice to be ready. */
  twinItemId: uuid.optional(),
  /** Display only. */
  voiceName: z.string().max(255).optional(),
  speed: z.number().min(0.8).max(1.25).default(1),
  instructions: z.string().trim().max(200).default(""),
}).strict();
export type PresenterVoice = z.infer<typeof PresenterVoiceSchema>;

export const PresenterDraftSchema = z.object({
  topic: z.string().max(800).default(""),
  script: z.string().max(2000).default(""),
  /** Target length used when writing the script; the takes decide the real length. */
  durationSec: z.number().int().min(10).max(90).default(30),
  /** image: a portrait driven by the voice (wan2.2-s2v). video: lip sync on recorded footage (VideoRetalk). */
  mode: z.enum(["image", "video"]).default("image"),
  voice: PresenterVoiceSchema.default({}),
  /** Upload asset IDs (private materials). */
  portrait: uuid.optional(),
  baseVideo: uuid.optional(),
  faceReference: uuid.optional(),
  /** Image mode: the portrait is cropped to this ratio, which the output keeps. */
  ratio: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  resolution: z.enum(["480P", "720P"]).default("720P"),
  /** Burn the script as captions, timed to each take's pauses. */
  subtitles: z.boolean().default(true),
  /** Caption style and per-segment line breaks, as in marketing videos; an entry's `script` is
   * its segment's text. A made video composes again with changes here, without the model. */
  captions: MarketingCaptionsSchema.optional(),
  /** The user confirmed the portrait / footage and voice are their own or authorized. */
  consent: z.boolean().default(false),
}).strict();
export type PresenterDraft = z.infer<typeof PresenterDraftSchema>;

export interface PresenterSegment { index: number; text: string; estimateSec: number }
export type PresenterTakeStatus = "missing" | "running" | "succeeded" | "failed";
export interface PresenterTake { slot: number; status: PresenterTakeStatus; durationMs?: number }

export type PresenterTaskStatus = "draft" | "pending" | "running" | "succeeded" | "failed" | "cancelled";
/** The marketing copy check applied to the spoken script. */
export interface PresenterReviewIssue { field: string; text: string; reason: string; suggestion?: string; severity?: "reject" | "suspect"; source?: string }
export interface PresenterReview { verdict: "pass" | "suspect" | "reject"; issues: PresenterReviewIssue[]; dropped?: number; reviewedAt?: string }
export interface PresenterTaskState {
  id: string; version: number; taskId?: string; status: PresenterTaskStatus; progress: number;
  stage?: string; error?: string; errorCode?: string;
  /** `captions`: cues burned in, in seconds of the film (`shot` is the segment); `frame`: the film's size. */
  output?: { assetIds?: string[]; assets?: { url: string; mime: string; durationSec?: number }[]; captions?: MarketingCaption[]; frame?: { width: number; height: number } };
  /** Clips sent to the model without a known outcome; resending may charge again. */
  unknownClips?: number;
}
export interface PresenterProject extends PresenterTaskState {
  draft: PresenterDraft; updatedAt: string;
  /** The latest check of the current script; absent or stale means it must be checked again. */
  review?: PresenterReview;
  reviewedScript?: string;
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/g;
/** Rough speech length at speed 1: about 4.2 CJK characters or 2.6 other words per second. */
export function estimateSpeechSec(text: string, speed = 1): number {
  const cjk = (text.match(CJK) ?? []).length;
  const words = text.replace(CJK, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
  return (cjk / 4.2 + words / 2.6) / speed;
}

/** Sentences end at Chinese / Latin terminal punctuation or a line break; the mark stays with its sentence. */
export function splitSentences(script: string): string[] {
  const chars = Array.from(script.replace(/\r\n?/g, "\n"));
  const out: string[] = [];
  let current = "";
  const flush = () => {
    const text = current.trim(); current = "";
    if (!text) return;
    // Stray punctuation joins the previous sentence instead of becoming its own take.
    if (!/[\p{L}\p{N}]/u.test(text)) { if (out.length) out[out.length - 1] += text; }
    else out.push(text);
  };
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === "\n") { flush(); continue; }
    current += char;
    // A Latin period ends a sentence only before a space or the end, so "2.5" stays whole.
    const end = /[。！？!?；;…]/.test(char) || (char === "." && (i + 1 === chars.length || /\s/.test(chars[i + 1])));
    if (!end) continue;
    while (i + 1 < chars.length && /[。！？!?；;….]/.test(chars[i + 1])) current += chars[++i];
    while (i + 1 < chars.length && /["”’」』）)]/.test(chars[i + 1])) current += chars[++i];
    flush();
  }
  flush();
  return out;
}

/**
 * Groups sentences into takes, each expected to last about PRESENTER_SEGMENT_TARGET_SEC.
 * One take per sentence group keeps every s2v request under its 20-second audio limit,
 * and an edited sentence only needs its own take again.
 */
export function planPresenterSegments(script: string, speed = 1): { segments: PresenterSegment[]; error?: string } {
  const sentences = splitSentences(script);
  if (!sentences.length) return { segments: [], error: "请先填写口播文案。" };
  const long = sentences.findIndex(text => estimateSpeechSec(text, speed) > PRESENTER_SENTENCE_MAX_SEC || Array.from(text).length > 300);
  if (long >= 0) return { segments: [], error: `第 ${long + 1} 句过长，请用句号拆成更短的句子。` };
  const segments: PresenterSegment[] = [];
  let current = "";
  for (const sentence of sentences) {
    const joined = current ? `${current}${/[^\x00-\x7f]$/.test(current) ? "" : " "}${sentence}` : sentence;
    if (current && estimateSpeechSec(joined, speed) > PRESENTER_SEGMENT_TARGET_SEC) {
      segments.push({ index: segments.length, text: current, estimateSec: estimateSpeechSec(current, speed) });
      current = sentence;
    } else current = joined;
  }
  if (current) segments.push({ index: segments.length, text: current, estimateSec: estimateSpeechSec(current, speed) });
  if (segments.length > PRESENTER_MAX_SEGMENTS) return { segments, error: `文案过长，最多分 ${PRESENTER_MAX_SEGMENTS} 段，请精简后再试。` };
  return { segments };
}

export const presenterModel = (mode: PresenterDraft["mode"]) => mode === "image" ? PRESENTER_IMAGE_MODEL : PRESENTER_VIDEO_MODEL;

/** Length of the voice track: takes back to back, with a short pause between them. */
export function presenterTrackMs(durations: number[]): number {
  return durations.reduce((sum, ms) => sum + ms, 0) + Math.max(0, durations.length - 1) * PRESENTER_SEGMENT_GAP_MS;
}

/** Why the measured takes cannot be generated in this mode, if anything. */
export function presenterTakesIssue(mode: PresenterDraft["mode"], durations: number[]): string {
  const total = presenterTrackMs(durations);
  if (mode === "image") {
    const index = durations.findIndex(ms => ms >= PRESENTER_SEGMENT_MAX_MS);
    if (index >= 0) return `第 ${index + 1} 段配音长于 19.5 秒，请拆分该段文案或调快语速后重新配音。`;
    if (total > PRESENTER_IMAGE_MAX_MS) return "以图生成的配音总长不能超过 90 秒，请精简文案。";
    return "";
  }
  if (total < PRESENTER_RETALK_MIN_MS) return "配音总长需超过 2 秒。";
  if (total > PRESENTER_RETALK_MAX_MS) return "以视频生成的配音总长不能超过 118 秒，请精简文案或调快语速。";
  return "";
}

/** What a draft still needs before its takes can be synthesized. */
export function presenterSpeechBlocker(draft: PresenterDraft): string {
  if (!draft.voice.twinItemId) return "请先选择数字分身音色。";
  return planPresenterSegments(draft.script, draft.voice.speed).error ?? "";
}

/** What a draft still needs before generation, apart from takes and the script check. */
export function presenterMaterialBlocker(draft: PresenterDraft): string {
  if (draft.mode === "image" && !draft.portrait) return "请选择或上传人物肖像。";
  if (draft.mode === "video" && !draft.baseVideo) return "请上传口播底片视频。";
  if (!draft.consent) return "请确认肖像、底片和声音均为本人或已获授权。";
  return "";
}

/** Segments whose edited caption lines no longer hold their words. */
export function presenterCaptionErrors(captions: MarketingCaptions | undefined, texts: string[]) {
  return texts.flatMap((text, index) => {
    const lines = marketingShotCaption({ captions }, index, text)?.lines;
    return lines && !marketingCaptionLinesMatch(text, lines) ? [index] : [];
  });
}
