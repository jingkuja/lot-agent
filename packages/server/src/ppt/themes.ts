import { DEFAULT_THEME, type PptTheme } from "./theme-extractor.js";

const FONTS = { major: "Microsoft YaHei", minor: "Microsoft YaHei" };
const SIZE = { slideWidthIn: 13.333, slideHeightIn: 7.5 };

/** 5 套完整 ThemePack；配色为 6 位 hex 无 #，与 PptTheme 约定一致。 */
export const THEME_PRESETS: Record<string, PptTheme> = {
  business: {
    colors: { dk1: "1B2A4A", lt1: "FFFFFF", lt2: "F2F5FA", dk2: "3C4A63",
      accent1: "2D6CDF", accent2: "17A2B8", accent3: "6C5CE7",
      accent4: "00B894", accent5: "0984E3", accent6: "E17055" },
    fonts: FONTS, ...SIZE, decor: "circles",
  },
  "tech-dark": {
    colors: { dk1: "E8ECF4", lt1: "FFFFFF", lt2: "141A24", dk2: "AEB8CC",
      accent1: "4C8DFF", accent2: "22D3EE", accent3: "A78BFA",
      accent4: "34D399", accent5: "60A5FA", accent6: "F472B6" },
    fonts: FONTS, ...SIZE, decor: "grid",
  },
  warm: {
    colors: { dk1: "3A2A1E", lt1: "FFFFFF", lt2: "FDF6EF", dk2: "6B4E3A",
      accent1: "E8590C", accent2: "F08C00", accent3: "E03131",
      accent4: "F59F00", accent5: "D9480F", accent6: "C2255C" },
    fonts: FONTS, ...SIZE, decor: "slant",
  },
  mono: {
    colors: { dk1: "1A1A1A", lt1: "FFFFFF", lt2: "F5F5F5", dk2: "4A4A4A",
      accent1: "222222", accent2: "555555", accent3: "888888",
      accent4: "2D2D2D", accent5: "6E6E6E", accent6: "999999" },
    fonts: FONTS, ...SIZE, decor: "minimal",
  },
  academic: {
    colors: { dk1: "17332A", lt1: "FFFFFF", lt2: "F0F5F2", dk2: "365248",
      accent1: "2F9E6E", accent2: "1E7A54", accent3: "3BAE8C",
      accent4: "0CA678", accent5: "099268", accent6: "66A80F" },
    fonts: FONTS, ...SIZE, decor: "grid",
  },
};

export const PRESET_LABELS: { id: string; label: string }[] = [
  { id: "business", label: "商务蓝" },
  { id: "tech-dark", label: "科技深色" },
  { id: "warm", label: "暖橙创意" },
  { id: "mono", label: "极简黑白" },
  { id: "academic", label: "学术绿" },
];

export function getPreset(name?: string): PptTheme | null {
  if (!name) return null;
  return THEME_PRESETS[name] ?? null;
}

// 确保 DEFAULT_THEME 被引用（避免 tree-shake 顾虑，无副作用）
export const FALLBACK_THEME: PptTheme = DEFAULT_THEME;
