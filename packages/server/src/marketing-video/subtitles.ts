import { speechUnits } from "@lot-agent/core/marketing-video";

/** One caption line, in seconds from the start of its shot. */
export interface Cue { start: number; end: number; text: string }
/** A silent stretch of a narration take, in seconds. */
export interface Pause { start: number; end: number }

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
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

/** Times one shot's lines against its narration take. Speech spans the take minus its
 * leading and trailing silence; line breaks fall in proportion to the spoken text and
 * move to a pause in the take when one is close. Each line stays up until the next
 * one is spoken; the last leaves shortly after the take ends. */
export function timeCaptions(lines: string[], voiceSec: number, shotSec: number, pauses: Pause[] = []): Cue[] {
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
  const used = new Set<Pause>();
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

/** Caption box of a frame size: font size, line width and bottom margin. Vertical videos
 * keep captions above the area that short-video apps cover with their own controls. */
export function captionLayout(width: number, height: number) {
  const fontSize = Math.round(Math.min(width, height) * 0.055);
  return { fontSize, maxCells: Math.floor(width * 0.8 / fontSize), marginV: Math.round(height * (height > width ? 0.16 : 0.08)) };
}

const assTime = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
// ASS reads braces as override tags and backslashes as escapes; show them as plain text.
const assText = (text: string) => text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\s+/g, " ");

/** An ASS script for one shot at the composed frame size. The font must exist on the host;
 * the Docker image installs Noto CJK (MARKETING_SUBTITLE_FONT overrides the family). */
export function captionAss(cues: Cue[], width: number, height: number) {
  const { fontSize, marginV } = captionLayout(width, height);
  const font = (process.env.MARKETING_SUBTITLE_FONT || "Noto Sans CJK SC").replace(/[,\r\n]/g, " ");
  const outline = Math.max(2, Math.round(fontSize * 0.08));
  const side = Math.round(width * 0.06);
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${font},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},1,2,${side},${side},${marginV},1`, "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...cues.map(cue => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${assText(cue.text)}`), "",
  ].join("\n");
}
