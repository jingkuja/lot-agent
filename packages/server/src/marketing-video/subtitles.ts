import { captionLayout, type MarketingCaptionCue, type MarketingCaptions } from "@lot-agent/core/marketing-video";

export { captionCells, captionLayout, captionLines, offsetCues, timeCaptions } from "@lot-agent/core/marketing-video";
export type { MarketingCaptionCue as Cue, MarketingCaptionPause as Pause } from "@lot-agent/core/marketing-video";

const assTime = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
// ASS reads braces as override tags and backslashes as escapes; show them as plain text.
const assText = (text: string) => text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\s+/g, " ");

/** An ASS script for one shot at the composed frame size. The font must exist on the host;
 * the Docker image installs Noto CJK (MARKETING_SUBTITLE_FONT overrides the family). */
export function captionAss(cues: MarketingCaptionCue[], width: number, height: number, style?: Pick<MarketingCaptions, "size" | "position">) {
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
