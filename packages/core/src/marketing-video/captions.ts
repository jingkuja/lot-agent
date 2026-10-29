import { speechUnits, type MarketingCaptions, type MarketingDraft } from "./index.js";

// Locally burned captions: line splitting, layout, timing against a shot's voice and the per-shot
// changes a made video may compose again with. Finding the pauses in the audio stays in the server.

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

// Latin words and numbers (with their decimal points, separators and units) stay whole.
const LATIN = /[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ.,%'’+\-/]*/gu;
const NO_BREAK_BEFORE = /[\p{Pe}\p{Pf}\p{Po}]/u;
const NO_BREAK_AFTER = /[\p{Ps}\p{Pi}\p{Sc}]/u;
const MIN_LINE_CELLS = 4;
const words = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "word" }) : undefined;

// The segmenter splits measure words, suffixes and verb compounds (一/款, 航空/级, 耐/摔)
// into one-character words. Breaking next to one costs as much as lines 1 cell less even,
// between two of them 1.7 cells.
const SINGLE_HAN = /^\p{Script=Han}$/u;
const HAN_END = /\p{Script=Han}$/u;
const HAN_START = /^\p{Script=Han}/u;
function splitCost(before: string, after: string) {
  if (!HAN_END.test(before) || !HAN_START.test(after)) return 0;
  return SINGLE_HAN.test(before) && SINGLE_HAN.test(after) ? 3 : SINGLE_HAN.test(before) || SINGLE_HAN.test(after) ? 1 : 0;
}

/** Where a wrapped line may end, with the cost of ending there: word boundaries, or any
 * character boundary when `anyChar`. Never inside a Latin word or number, before closing
 * punctuation or after an opening one. */
function breakPoints(clause: string, anyChar: boolean) {
  const points = new Map<number, number>();
  if (!anyChar && words) {
    let previous = "";
    for (const { index, segment } of words.segment(clause)) {
      points.set(index, splitCost(previous, segment));
      previous = segment;
    }
  } else for (let at = 0; at < clause.length; at += clause.codePointAt(at)! > 0xffff ? 2 : 1) points.set(at, 0);
  for (const match of clause.matchAll(LATIN)) for (let at = match.index + 1; at < match.index + match[0].length; at++) points.delete(at);
  for (const at of points.keys()) if (!at || NO_BREAK_BEFORE.test(clause[at]) || NO_BREAK_AFTER.test(clause[at - 1])) points.delete(at);
  return points;
}

/** `count` lines no wider than `maxCells`, ending at `points` and as even as possible.
 * A line under 4 cells is a last resort. Undefined when the lines cannot fit. */
function balance(clause: string, points: Map<number, number>, count: number, maxCells: number) {
  const ends = [0, ...[...points.keys()].sort((a, b) => a - b), clause.length];
  const target = captionCells(clause) / count;
  // cost[k][j]: least cost of k lines that end at ends[j]; from[k][j] is where the last one starts.
  const cost = Array.from({ length: count + 1 }, () => ends.map(() => Infinity));
  const from = Array.from({ length: count + 1 }, () => ends.map(() => 0));
  cost[0][0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let j = 1; j < ends.length; j++) {
      for (let i = 0; i < j; i++) {
        if (cost[k - 1][i] === Infinity) continue;
        const width = captionCells(clause.slice(ends[i], ends[j]).trim());
        if (!width || width > maxCells) continue;
        const next = cost[k - 1][i] + (width - target) ** 2 + (width < MIN_LINE_CELLS ? 1000 : 0) + (points.get(ends[j]) ?? 0);
        if (next < cost[k][j]) { cost[k][j] = next; from[k][j] = i; }
      }
    }
  }
  if (cost[count][ends.length - 1] === Infinity) return undefined;
  const lines: string[] = [];
  for (let k = count, j = ends.length - 1; k > 0; j = from[k][j], k--) lines.unshift(clause.slice(ends[from[k][j]], ends[j]));
  return lines;
}

/** Splits an over-long clause into the fewest near-equal lines, breaking between words when it can. */
function wrap(clause: string, maxCells: number) {
  const total = captionCells(clause);
  if (total <= maxCells) return [clause];
  const wordPoints = breakPoints(clause, false), charPoints = breakPoints(clause, true);
  const ends = [0, ...[...charPoints.keys()].sort((a, b) => a - b), clause.length];
  // A Latin word wider than the line gets a line of its own.
  const limit = Math.max(maxCells, ...ends.slice(1).map((end, i) => captionCells(clause.slice(ends[i], end).trim())));
  for (let count = Math.ceil(total / limit); count < ends.length; count++) {
    const lines = balance(clause, wordPoints, count, limit) ?? balance(clause, charPoints, count, limit);
    if (lines) return lines;
  }
  return [clause];
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
/** Caption colours, burned by the composition and drawn by the live preview alike. An outline preset strokes each glyph;
 * a `box` preset puts a translucent band behind each line instead. */
export const MARKETING_CAPTION_COLORS: Record<MarketingCaptions["color"], { text: string; outline?: string; box?: string }> = {
  white: { text: "#FFFFFF", outline: "#000000" },
  yellow: { text: "#FFD400", outline: "#000000" },
  black: { text: "#111111", outline: "#FFFFFF" },
  box: { text: "#FFFFFF", box: "#000000" },
  "yellow-box": { text: "#FFD400", box: "#000000" },
};
/** Opacity of a caption band. */
export const MARKETING_CAPTION_BOX_OPACITY = 0.6;
/** Glyph outline width, and the band's padding around a line, in composed pixels. */
export const captionStroke = (fontSize: number, color: MarketingCaptions["color"] = "white") =>
  MARKETING_CAPTION_COLORS[color].box ? Math.round(fontSize * 0.2) : Math.max(2, Math.round(fontSize * 0.08));
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
  return value.size === "medium" && value.position === "medium" && (value.color ?? "white") === "white" && !value.offsetSec && !shots.length
    ? undefined : value;
}

/** One caption line, in seconds from the start of its shot. */
export interface MarketingCaptionCue { start: number; end: number; text: string }
/** A silent stretch of a narration take, in seconds. */
export interface MarketingCaptionPause { start: number; end: number }

/** Times one shot's lines against its narration take. Speech spans the take minus its
 * leading and trailing silence; line breaks fall in proportion to the spoken text and
 * move to a pause in the take when one is close. Each line stays up until the next
 * one is spoken; the last leaves shortly after the take ends. */
export function timeCaptions(lines: string[], voiceSec: number, shotSec: number, pauses: MarketingCaptionPause[] = []): MarketingCaptionCue[] {
  if (!lines.length) return [];
  const edge = 0.05;
  const leading = pauses.find(pause => pause.start <= edge);
  const trailing = pauses.find(pause => pause.end >= voiceSec - edge && pause !== leading);
  const speechStart = leading && leading.end < voiceSec ? leading.end : 0;
  const speechEnd = trailing && trailing.start > speechStart ? trailing.start : voiceSec;
  const inner = pauses.filter(pause => pause !== leading && pause !== trailing && pause.start > speechStart && pause.end < speechEnd);
  const weights = lines.map(line => Math.max(1, speechUnits(line)));
  const cumulative = weights.reduce<number[]>((sums, weight) => [...sums, (sums.at(-1) ?? 0) + weight], [0]);
  const total = cumulative.at(-1)!;
  const span = speechEnd - speechStart;
  const tolerance = Math.max(0.6, 0.35 * span / lines.length);
  // Anchors: speech start, boundaries moved to a pause, speech end.
  const anchors = [{ index: 0, at: speechStart }];
  const used = new Set<MarketingCaptionPause>();
  for (let index = 1; index < lines.length; index++) {
    const estimate = speechStart + span * cumulative[index] / total;
    const previous = anchors.at(-1)!.at;
    const pause = inner.filter(p => !used.has(p) && (p.start + p.end) / 2 > previous && Math.abs((p.start + p.end) / 2 - estimate) <= tolerance)
      .sort((a, b) => Math.abs((a.start + a.end) / 2 - estimate) - Math.abs((b.start + b.end) / 2 - estimate))[0];
    if (pause) { used.add(pause); anchors.push({ index, at: pause.end }); }
  }
  anchors.push({ index: lines.length, at: speechEnd });
  const starts = lines.map((_, index) => {
    const after = anchors.findIndex(anchor => anchor.index >= index);
    if (anchors[after].index === index) return anchors[after].at;
    const before = anchors[after - 1];
    const next = anchors[after];
    return before.at + (next.at - before.at) * (cumulative[index] - cumulative[before.index]) / (cumulative[next.index] - cumulative[before.index]);
  });
  starts[0] = Math.max(0, speechStart - 0.1);
  const last = Math.min(shotSec - edge, speechEnd + 0.5);
  return lines.map((text, index) => ({ start: starts[index], end: index + 1 < lines.length ? starts[index + 1] : last, text }));
}

/** Moves a shot's cues by `offset` seconds, as far as the shot allows: the first line keeps at
 * least `min` seconds after the start and the last one before the end, so no line is lost. */
export function offsetCues(cues: MarketingCaptionCue[], offset: number, shotSec: number, min = 0.3): MarketingCaptionCue[] {
  if (!offset || !cues.length) return cues;
  const limit = shotSec - 0.05;
  const shift = Math.min(Math.max(offset, min - cues[0].end), limit - min - cues.at(-1)!.start);
  if ((offset < 0 && shift > 0) || (offset > 0 && shift < 0)) return cues;
  const at = (sec: number) => Math.min(limit, Math.max(0, sec + shift));
  return cues.map(cue => ({ ...cue, start: at(cue.start), end: at(cue.end) }));
}

/** What timing one shot's captions needs, kept with a made video so caption changes can be
 * previewed without composing it again: the line it said, its length, and its voice's length and
 * silent stretches (a shot without a voice is timed against its whole length). */
export interface MarketingCaptionTiming { script: string; durationSec: number; voiceSec: number; pauses: MarketingCaptionPause[] }

/** One shot's caption cues for the draft's current line breaks and offsets, in seconds of the shot. */
export function marketingShotCues(draft: Pick<MarketingDraft, "captions">, index: number, timing: MarketingCaptionTiming, maxCells: number) {
  const lines = marketingCaptionLines(draft, index, timing.script, maxCells);
  const cues = timeCaptions(lines, timing.voiceSec, timing.durationSec, timing.pauses);
  return offsetCues(cues, marketingCaptionOffset(draft, index, timing.script), timing.durationSec);
}

/** The captions a made video would get if composed again with the draft's caption settings, in
 * seconds of the film. `changed` lists shots whose line differs from the one the video says:
 * their timing is unknown until it is composed again, so they get no captions here. */
export function marketingPreviewCaptions(draft: Pick<MarketingDraft, "captions" | "storyboard" | "quality" | "ratio">,
  timing: MarketingCaptionTiming[]): { captions: MarketingCaption[]; changed: number[] } {
  const { width, height } = marketingFrameSize(draft);
  const maxCells = captionLayout(width, height, draft.captions).maxCells;
  const captions: MarketingCaption[] = [], changed: number[] = [];
  let shotStart = 0;
  timing.forEach((shot, index) => {
    if (draft.storyboard[index]?.script !== shot.script) changed.push(index);
    else {
      const at = (sec: number) => Math.round((shotStart + sec) * 100) / 100;
      captions.push(...marketingShotCues(draft, index, shot, maxCells).map(cue => ({ shot: index, start: at(cue.start), end: at(cue.end), text: cue.text })));
    }
    shotStart += shot.durationSec;
  });
  return { captions, changed };
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
