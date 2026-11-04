import { useI18n } from "../i18n/index.js";
import { useEffect, useState } from "react";
import { EDGE_MARGIN, useDraggablePosition } from "../hooks/useDraggablePosition.js";
import { useTheme } from "../hooks/useTheme.js";
import type { Theme } from "../lib/theme.js";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

/** Approx. menu box used to decide which way it should open. */
const MENU_W = 144;
const MENU_H = 96;
const POS_KEY = "lot:theme-toggle-pos";

type Placement = { h: "left" | "right"; v: "up" | "down" };

export function ThemeToggle() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  // Which way the menu opens; recomputed each time it's opened so it never
  // spills off-screen after the button is dragged to an edge.
  const [placement, setPlacement] = useState<Placement>({ h: "right", v: "down" });
  // Don't keep the menu open while dragging.
  const { ref, style, pointerHandlers, consumeDrag } = useDraggablePosition<HTMLDivElement>(POS_KEY, () => setOpen(false));

  // Close the menu on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref]);

  const handleClick = () => {
    if (consumeDrag()) return;
    setOpen((v) => {
      // About to open: pick the open direction with the most room so the menu
      // never runs off the left/bottom edge.
      if (!v) {
        const r = ref.current?.getBoundingClientRect();
        if (r) {
          setPlacement({
            h: r.right - MENU_W < EDGE_MARGIN ? "left" : "right",
            v: r.bottom + MENU_H > window.innerHeight - EDGE_MARGIN ? "up" : "down",
          });
        }
      }
      return !v;
    });
  };

  const choose = (value: Theme) => {
    setTheme(value);
    setOpen(false);
  };

  return (
    <div
      className="theme-toggle"
      ref={ref}
      style={style}
    >
      <button
        type="button"
        className="theme-toggle-btn"
        onClick={handleClick}
        {...pointerHandlers}
        aria-label={t("切换主题")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("切换主题（可拖动）")}
      >
        {theme === "dark" ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4.5" />
            <line x1="12" y1="2.5" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="21.5" />
            <line x1="4.22" y1="4.22" x2="5.99" y2="5.99" />
            <line x1="18.01" y1="18.01" x2="19.78" y2="19.78" />
            <line x1="2.5" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="21.5" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.99" y2="18.01" />
            <line x1="18.01" y1="5.99" x2="19.78" y2="4.22" />
          </svg>
        )}
      </button>

      {open && (
        <div
          className={`theme-menu theme-menu--${placement.h} theme-menu--${placement.v}`}
          role="menu"
        >
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === opt.value}
              className={`theme-menu-item ${theme === opt.value ? "active" : ""}`}
              onClick={() => choose(opt.value)}
            >
              <span>{t(opt.label)}</span>
              {theme === opt.value && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
