import { useEffect, useRef, useState } from "react";
import { useTheme } from "../hooks/useTheme.js";
import type { Theme } from "../lib/theme.js";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
  }, [open]);

  const choose = (value: Theme) => {
    setTheme(value);
    setOpen(false);
  };

  return (
    <div className="theme-toggle" ref={ref}>
      <button
        type="button"
        className="theme-toggle-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="切换主题"
        aria-haspopup="menu"
        aria-expanded={open}
        title="切换主题"
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
        <div className="theme-menu" role="menu">
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === opt.value}
              className={`theme-menu-item ${theme === opt.value ? "active" : ""}`}
              onClick={() => choose(opt.value)}
            >
              <span>{opt.label}</span>
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
