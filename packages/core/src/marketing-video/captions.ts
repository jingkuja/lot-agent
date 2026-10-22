import type { MarketingCaptions, MarketingDraft } from "./index.js";

// Locally burned captions: line splitting, layout and the per-shot changes a made video
// may compose again with. Timing against the audio stays in the server.

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
/** Display width in full-width cells; Latin letters and digits are about half a cell. */
export function captionCells(text: string) {
  let cells = 0;
  for (const char of text) cells += WIDE.test(char) ? 1 : 0.55;
  return cells;
}

const ALWAYS_BREAK = /[，。！？；、：…!?;\n]/;
// Latin , . : break only before a space or the end, so 1,999 and 3.5 stay whole.
const SOFT_BREAK = /[,.:]/;
const CLOSING = /[”’」』）》】)"'\]]/;
const TRAILING = /[，。、；：,.;:\s]+$/;

/** Clauses of the confirmed copy, each with its own punctuation. */
function clauses(script: string) {
  const out: string[] = [];
  const chars = Array.from(script);
  let current = "";
  for (let i = 0; i < chars.length; i++) {
    current += chars[i];
    const next = chars[i + 1];
    if (!ALWAYS_BREAK.test(chars[i]) && !(SOFT_BREAK.test(chars[i]) && (next === undefined || /\s/.test(next)))) continue;
    while (chars[i + 1] && (CLOSING.test(chars[i + 1]) || ALWAYS_BREAK.test(chars[i + 1]))) current += chars[++i];
    out.push(current); current = "";
  }
  out.push(current);
  return out.filter(clause => clause.replace(TRAILING, "").trim());
}

/** Splits an over-long clause into near-equal pieces, never inside a Latin word or number. */
function wrap(clause: string, maxCells: number) {
  const total = captionCells(clause);
  if (total <= maxCells) return [clause];
  const target = total / Math.ceil(total / maxCells);
  // Latin words and numbers (with their decimal points, separators and units) stay whole.
  const tokens = clause.match(/[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ.,%'’+\-/]*|\s+|./gu) ?? [];
  const pieces: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (current.trim() && captionCells(current + token) > target + 0.3) { pieces.push(current); current = ""; }
    current += token;
  }
  pieces.push(current);
  return pieces.filter(piece => piece.trim());
}

/** Caption lines of one shot's confirmed copy: split at punctuation, short clauses joined,
 * long ones wrapped to `maxCells`. The words are the copy's own; only line-final
 * commas and full stops are dropped, as is usual for subtitles. */
export function captionLines(script: string, maxCells: number) {
  const merged: string[] = [];
  for (const clause of clauses(script)) {
    const last = merged.at(-1);
    if (last !== undefined && (captionCells(last.replace(TRAILING, "")) < 4 || captionCells(clause.replace(TRAILING, "")) < 3)
      && captionCells((last + clause).replace(TRAILING, "")) <= maxCells) merged[merged.length - 1] = last + clause;
    else merged.push(clause);
  }
  return merged.flatMap(clause => wrap(clause, maxCells)).map(line => line.replace(TRAILING, "").trim()).filter(Boolean);
}

/** Frame size a draft is composed at, in even pixels. */
export function marketingFrameSize(draft: Pick<MarketingDraft, "quality" | "ratio">) {
  const edge = draft.quality === "1080p" ? 1080 : 720;
  const [rw, rh] = draft.ratio.split(":").map(Number);
  return { width: Math.round(edge * rw / Math.min(rw, rh) / 2) * 2, height: Math.round(edge * rh / Math.min(rw, rh) / 2) * 2 };
}

const FONT_SCALE = { small: 0.045, medium: 0.055, large: 0.068 } as const;
// Bottom margin as a share of the height: vertical videos, then landscape and square ones.
const MARGIN = { low: [0.1, 0.05], medium: [0.16, 0.08], high: [0.24, 0.14] } as const;
/** Caption box of a frame size: font size, line width and bottom margin. By default vertical
 * videos keep captions above the area that short-video apps cover with their own controls. */
export function captionLayout(width: number, height: number, style?: Partial<Pick<MarketingCaptions, "size" | "position">>) {
  const fontSize = Math.round(Math.min(width, height) * FONT_SCALE[style?.size ?? "medium"]);
  const [vertical, other] = MARGIN[style?.position ?? "medium"];
  return { fontSize, maxCells: Math.floor(width * 0.8 / fontSize), marginV: Math.round(height * (height > width ? vertical : other)) };
}

const captionLetters = (text: string) => text.replace(/[\s\p{P}]/gu, "");
/** Edited lines may move line breaks and punctuation, never change the shot's words. */
export const marketingCaptionLinesMatch = (script: string, lines: string[]) => captionLetters(lines.join("")) === captionLetters(script);

/** The caption change saved for one shot, while the shot still says `script`. A reworded
 * shot or a copied draft with other shots falls back to the automatic captions. */
export function marketingShotCaption(draft: Pick<MarketingDraft, "captions">, index: number, script: string) {
  const entry = draft.captions?.shots[index];
  return entry && entry.script === script ? entry : undefined;
}

/** Lines burned for one shot: the user's line breaks when they hold its words, else the automatic split. */
export function marketingCaptionLines(draft: Pick<MarketingDraft, "captions">, index: number, script: string, maxCells: number) {
  const lines = marketingShotCaption(draft, index, script)?.lines;
  return lines && marketingCaptionLinesMatch(script, lines) ? lines : captionLines(script, maxCells);
}

/** Seconds one shot's captions move: the whole film's offset plus the shot's own. */
export function marketingCaptionOffset(draft: Pick<MarketingDraft, "captions">, index: number, script: string) {
  return Math.round(((draft.captions?.offsetSec ?? 0) + (marketingShotCaption(draft, index, script)?.offsetSec ?? 0)) * 100) / 100;
}

export const CAPTION_WORDS_CHANGED = "字幕只能调整断行和标点；要改文字，请修改该镜口播。";
/** Shots whose edited lines no longer hold their words. */
export function marketingCaptionErrors(draft: Pick<MarketingDraft, "captions" | "storyboard">) {
  return draft.storyboard.flatMap((shot, index) => {
    const lines = marketingShotCaption(draft, index, shot.script)?.lines;
    return lines && !marketingCaptionLinesMatch(shot.script, lines) ? [index] : [];
  });
}

/** Captions with nothing changed are left out, so a reverted draft equals the one that was made. */
export function marketingCaptionsValue(captions: MarketingCaptions | undefined): MarketingCaptions | undefined {
  if (!captions) return undefined;
  const shots = captions.shots.map(entry => entry && (entry.lines || entry.offsetSec) ? entry : null);
  while (shots.length && !shots.at(-1)) shots.pop();
  const value = { ...captions, offsetSec: Math.round(captions.offsetSec * 100) / 100, shots };
  return value.size === "medium" && value.position === "medium" && !value.offsetSec && !shots.length ? undefined : value;
}

/** Cue of the made video, in seconds of the film. */
export interface MarketingCaption { shot: number; start: number; end: number; text: string }
const srtTime = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};
/** The burned captions as an SRT file, for platforms that take captions separately. */
export function marketingCaptionSrt(captions: MarketingCaption[]) {
  return captions.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join("\n");
}
