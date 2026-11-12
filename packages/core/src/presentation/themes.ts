import type { PptThemeId } from "./deck.js";

/** Browser-safe theme tokens shared by the exporter and the theme picker. Colors are 6-digit hex without "#". */
export interface PptThemeColors {
  /** Title text. */
  dk1: string;
  /** Surface of cards and panels. */
  lt1: string;
  /** Body text. */
  dk2: string;
  /** Page background. */
  lt2: string;
  /** accent1 is the single emphasis color; the rest only extend chart series. */
  accent1: string; accent2: string; accent3: string;
  accent4: string; accent5: string; accent6: string;
}

export interface PptThemeStyle {
  /** Cover and closing composition. */
  cover: "split" | "spotlight" | "band" | "editorial" | "frame";
  /** Card treatment for keypoints, compare and stats panels. */
  card: "soft" | "outline" | "raised" | "rule" | "left-rule";
  /** Accent above or below body-page titles. */
  heading: "bar" | "eyebrow" | "rule" | "plain" | "underline";
}

export interface PptThemePreset { colors: PptThemeColors; style: PptThemeStyle }

export const PPT_DEFAULT_STYLE: PptThemeStyle = { cover: "split", card: "soft", heading: "bar" };

export const PPT_THEME_PRESETS: Record<PptThemeId, PptThemePreset> = {
  business: {
    colors: {
      dk1: "14213D", lt1: "FFFFFF", dk2: "4A5670", lt2: "F5F7FA",
      accent1: "1F5BD8", accent2: "8FB0EE", accent3: "9AA5B8", accent4: "0F2F73", accent5: "C9D7F5", accent6: "5F6B82",
    },
    style: { cover: "split", card: "soft", heading: "bar" },
  },
  "tech-dark": {
    colors: {
      dk1: "EEF2F8", lt1: "1A2234", dk2: "A7B2C6", lt2: "0D1220",
      accent1: "38BDF8", accent2: "1D6F99", accent3: "64748B", accent4: "7DD3FC", accent5: "334155", accent6: "94A3B8",
    },
    style: { cover: "spotlight", card: "outline", heading: "eyebrow" },
  },
  warm: {
    colors: {
      dk1: "33241A", lt1: "FFFFFF", dk2: "6B5546", lt2: "FBF5EE",
      accent1: "D9591E", accent2: "EFA67F", accent3: "B5A496", accent4: "8F3410", accent5: "F6D3BF", accent6: "7D6A5C",
    },
    style: { cover: "band", card: "raised", heading: "plain" },
  },
  mono: {
    colors: {
      dk1: "111111", lt1: "FFFFFF", dk2: "4D4D4D", lt2: "FFFFFF",
      accent1: "111111", accent2: "8C8C8C", accent3: "C4C4C4", accent4: "4D4D4D", accent5: "E0E0E0", accent6: "666666",
    },
    style: { cover: "editorial", card: "rule", heading: "rule" },
  },
  academic: {
    colors: {
      dk1: "16302A", lt1: "FFFFFF", dk2: "45594F", lt2: "F7F8F5",
      accent1: "23785A", accent2: "86BCA6", accent3: "A3AEA7", accent4: "114634", accent5: "CFE5DA", accent6: "65766D",
    },
    style: { cover: "frame", card: "left-rule", heading: "underline" },
  },
};

/** Chinese labels are i18n keys in the web client. */
export const PPT_THEME_LABELS: Record<PptThemeId, string> = {
  business: "商务蓝",
  "tech-dark": "科技深色",
  warm: "暖橙创意",
  mono: "极简黑白",
  academic: "学术绿",
};
