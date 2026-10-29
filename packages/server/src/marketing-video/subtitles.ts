import { captionLayout, captionStroke, MARKETING_CAPTION_BOX_OPACITY, MARKETING_CAPTION_COLORS, type MarketingCaptionCue,
  type MarketingCaptions } from "@lot-agent/core/marketing-video";

export { captionCells, captionLayout, captionLines, offsetCues, timeCaptions } from "@lot-agent/core/marketing-video";
export type { MarketingCaptionCue as Cue, MarketingCaptionPause as Pause } from "@lot-agent/core/marketing-video";

const assTime = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
/** `#RRGGBB` as an ASS colour, `&HAABBGGRR`, where alpha 0 is opaque. */
const assColor = (hex: string, opacity = 1) =>
  `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, "0")}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
// ASS reads braces as override tags and backslashes as escapes; show them as plain text.
const assText = (text: string) => text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\s+/g, " ");

/** An ASS script for one shot at the composed frame size. The font must exist on the host;
 * the Docker image installs Noto CJK (MARKETING_SUBTITLE_FONT overrides the family). */
export function captionAss(cues: MarketingCaptionCue[], width: number, height: number,
  style?: Partial<Pick<MarketingCaptions, "size" | "position" | "color">>) {
  const { fontSize, marginV } = captionLayout(width, height, style);
  const font = (process.env.MARKETING_SUBTITLE_FONT || "Noto Sans CJK SC").replace(/[,\r\n]/g, " ");
  const color = MARKETING_CAPTION_COLORS[style?.color ?? "white"];
  const outline = captionStroke(fontSize, style?.color);
  const side = Math.round(width * 0.06);
  // Border style 3 draws an opaque box in the outline colour, padded by the outline width; a box has no shadow.
  const edge = color.box ? `${assColor(color.box, MARKETING_CAPTION_BOX_OPACITY)},&H00000000,-1,0,0,0,100,100,0,0,3,${outline},0`
    : `${assColor(color.outline!)},&H80000000,-1,0,0,0,100,100,0,0,1,${outline},1`;
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${font},${fontSize},${assColor(color.text)},${assColor(color.text)},${edge},2,${side},${side},${marginV},1`, "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...cues.map(cue => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${assText(cue.text)}`), "",
  ].join("\n");
}
