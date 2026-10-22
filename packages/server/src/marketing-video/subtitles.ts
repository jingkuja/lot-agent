import { captionLayout, speechUnits, type MarketingCaptions } from "@lot-agent/core/marketing-video";

export { captionCells, captionLayout, captionLines } from "@lot-agent/core/marketing-video";

/** One caption line, in seconds from the start of its shot. */
export interface Cue { start: number; end: number; text: string }
/** A silent stretch of a narration take, in seconds. */
export interface Pause { start: number; end: number }

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

/** Moves a shot's cues by `offset` seconds, as far as the shot allows: the first line keeps at
 * least `min` seconds after the start and the last one before the end, so no line is lost. */
export function offsetCues(cues: Cue[], offset: number, shotSec: number, min = 0.3): Cue[] {
  if (!offset || !cues.length) return cues;
  const limit = shotSec - 0.05;
  const shift = Math.min(Math.max(offset, min - cues[0].end), limit - min - cues.at(-1)!.start);
  if ((offset < 0 && shift > 0) || (offset > 0 && shift < 0)) return cues;
  const at = (sec: number) => Math.min(limit, Math.max(0, sec + shift));
  return cues.map(cue => ({ ...cue, start: at(cue.start), end: at(cue.end) }));
}

const assTime = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
// ASS reads braces as override tags and backslashes as escapes; show them as plain text.
const assText = (text: string) => text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\s+/g, " ");

/** An ASS script for one shot at the composed frame size. The font must exist on the host;
 * the Docker image installs Noto CJK (MARKETING_SUBTITLE_FONT overrides the family). */
export function captionAss(cues: Cue[], width: number, height: number, style?: Pick<MarketingCaptions, "size" | "position">) {
  const { fontSize, marginV } = captionLayout(width, height, style);
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
