import { PPT_THEMES, PPT_THEME_LABELS, PPT_THEME_PRESETS, type PptThemeId } from "@lot-agent/core/presentation";
import { DEFAULT_THEME, type PptTheme } from "./theme-extractor.js";

const { fonts, slideWidthIn, slideHeightIn } = DEFAULT_THEME;

/** Built-in themes come from the shared presets so the picker previews match the export. */
export const THEME_PRESETS = Object.fromEntries(
  PPT_THEMES.map(id => [id, { ...PPT_THEME_PRESETS[id], fonts, slideWidthIn, slideHeightIn }]),
) as Record<PptThemeId, PptTheme>;

export const PRESET_LABELS = PPT_THEMES.map(id => ({ id, label: PPT_THEME_LABELS[id] }));

export function getPreset(name?: string): PptTheme | null {
  const id = PPT_THEMES.find(id => id === name);
  return id ? THEME_PRESETS[id] : null;
}
