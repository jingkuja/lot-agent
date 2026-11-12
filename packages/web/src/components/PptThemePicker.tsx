import { PPT_THEMES, PPT_THEME_LABELS, type PptThemeId } from "@lot-agent/core/presentation";
import { useI18n } from "../i18n/index.js";

interface PptThemePickerProps {
  value?: PptThemeId;
  onSelect?: (id: PptThemeId) => void;
  reexport?: boolean;
}

export function PptThemePicker({ value, onSelect, reexport }: PptThemePickerProps) {
  const { t } = useI18n();
  return <fieldset className="ppt-theme-picker" disabled={!onSelect}>
    <legend>{t(reexport ? "换主题并重新导出" : "视觉主题")}</legend>
    <div className="ppt-theme-options">
      {PPT_THEMES.map(id => <button
        key={id}
        type="button"
        className="ppt-theme-option"
        aria-pressed={value === id}
        disabled={reexport && value === id}
        onClick={() => onSelect?.(id)}
      >
        <img src={new URL(`../assets/ppt-themes/${id}.webp`, import.meta.url).href} alt="" width={320} height={180} />
        <span>{t(PPT_THEME_LABELS[id])}</span>
      </button>)}
    </div>
  </fieldset>;
}
