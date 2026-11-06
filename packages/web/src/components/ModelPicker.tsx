import { useI18n } from "../i18n/index.js";
import { useState, useRef, useEffect, useLayoutEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { filterModels, type CatalogModel } from "../lib/model-filter.js";

const POPUP_GAP = 10;
const VIEWPORT_MARGIN = 8;
/** Full popup height. The direction is chosen from this, not the filtered list, so typing never flips it. */
const POPUP_HEIGHT = 360;

/** Opens upward unless that would not fit and there is more room below. */
function placePopup(trigger: DOMRect, popupWidth: number): CSSProperties {
  const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
  const above = trigger.top - POPUP_GAP - VIEWPORT_MARGIN;
  const below = visibleHeight - trigger.bottom - POPUP_GAP - VIEWPORT_MARGIN;
  const left = Math.max(VIEWPORT_MARGIN, trigger.right - popupWidth);
  return above >= POPUP_HEIGHT || above >= below
    ? { left, top: "auto", bottom: window.innerHeight - trigger.top + POPUP_GAP, maxHeight: above }
    : { left, top: trigger.bottom + POPUP_GAP, maxHeight: below };
}

/** Bottom-right model selector with a letter quick-filter. Popover styling reuses
 * the media-picker tokens; all colors via var(--*). The popup renders in <body> because
 * the composer can sit inside a scrolling area, which would cut it off. */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  emptyLabel = "模型目录暂时不可用，请稍后重试",
}: {
  models: CatalogModel[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popupStyle, setPopupStyle] = useState<CSSProperties>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (triggerRef.current && popupRef.current) {
        setPopupStyle(placePopup(triggerRef.current.getBoundingClientRect(), popupRef.current.offsetWidth));
      }
    };
    const onScroll = (e: Event) => {
      if (!popupRef.current?.contains(e.target as Node)) place();
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isEmpty = models.length === 0;
  const currentModel = (!isEmpty && value && models.find((m) => m.id === value)) || models[0];
  const current = isEmpty ? "暂无模型" : (currentModel?.label ?? currentModel?.id ?? "选择模型");
  const filtered = filterModels(models, query);
  const showSearch = models.length > 2;

  return (
    <div className="media-picker model-picker">
      <button
        ref={triggerRef}
        type="button"
        className="media-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        title={t("选择模型")}
      >
        <span className="media-trigger-label">{t(current)}</span>
        <svg className="media-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && createPortal(
        <div className="media-popup model-popup" ref={popupRef} style={popupStyle}>
          {isEmpty ? (
            /* 目录为空:仅一行灰色提示,不可选;沿用 model-empty 样式 */
            <div className="model-empty">{t(emptyLabel)}</div>
          ) : (
            <>
              {showSearch && (
                <input
                  className="model-search"
                  autoFocus
                  placeholder={t("输入字母快速筛选…")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}
              <div className="model-list">
                {filtered.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`model-row ${m.id === value ? "active" : ""}`}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                    }}
                  >
                    <span className="model-row-name">{m.label ?? m.id}</span>
                    {m.description && <span className="model-row-desc">{m.description}</span>}
                  </button>
                ))}
                {filtered.length === 0 && <div className="model-empty">{t("无匹配模型")}</div>}
              </div>
            </>
          )}
        </div>
      , document.body)}
    </div>
  );
}
