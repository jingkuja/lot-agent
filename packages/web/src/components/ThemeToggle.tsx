import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../hooks/useTheme.js";
import type { Theme } from "../lib/theme.js";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

/** Pointer travel (px) before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Keep the button at least this far from the viewport edges. */
const EDGE_MARGIN = 8;
/** Approx. menu box used to decide which way it should open. */
const MENU_W = 144;
const MENU_H = 96;
const POS_KEY = "lot:theme-toggle-pos";

type Placement = { h: "left" | "right"; v: "up" | "down" };

type Pos = { left: number; top: number };

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.left === "number" && typeof p?.top === "number") return p;
  } catch {
    /* ignore malformed value */
  }
  return null;
}

function clampToViewport(left: number, top: number, w: number, h: number): Pos {
  return {
    left: Math.min(Math.max(left, EDGE_MARGIN), window.innerWidth - w - EDGE_MARGIN),
    top: Math.min(Math.max(top, EDGE_MARGIN), window.innerHeight - h - EDGE_MARGIN),
  };
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  // null = default (CSS top/right anchor); once dragged, an explicit left/top.
  const [pos, setPos] = useState<Pos | null>(() => loadPos());
  // Which way the menu opens; recomputed each time it's opened so it never
  // spills off-screen after the button is dragged to an edge.
  const [placement, setPlacement] = useState<Placement>({ h: "right", v: "down" });
  const ref = useRef<HTMLDivElement>(null);

  // Per-drag scratch: pointer start, grab offset within the button, whether it
  // has crossed the threshold yet.
  const drag = useRef<{ startX: number; startY: number; offX: number; offY: number; moved: boolean } | null>(null);
  // Set true on pointer-up of a real drag so the synthetic click that follows
  // doesn't open the menu.
  const draggedRef = useRef(false);

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

  // Persist the dragged position.
  useEffect(() => {
    if (!pos) return;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [pos]);

  // Keep the button on-screen if the window shrinks.
  useEffect(() => {
    const onResize = () => {
      const el = ref.current;
      if (!el) return;
      setPos((prev) => {
        if (!prev) return prev;
        const r = el.getBoundingClientRect();
        return clampToViewport(prev.left, prev.top, r.width, r.height);
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) {
      return;
    }
    d.moved = true;
    setOpen(false); // don't keep the menu open while dragging
    const r = el.getBoundingClientRect();
    setPos(clampToViewport(e.clientX - d.offX, e.clientY - d.offY, r.width, r.height));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) draggedRef.current = true; // swallow the trailing click
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handleClick = useCallback(() => {
    if (draggedRef.current) {
      draggedRef.current = false; // this click ended a drag — ignore it
      return;
    }
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
  }, []);

  const choose = (value: Theme) => {
    setTheme(value);
    setOpen(false);
  };

  return (
    <div
      className="theme-toggle"
      ref={ref}
      style={pos ? { left: pos.left, top: pos.top, right: "auto" } : undefined}
    >
      <button
        type="button"
        className="theme-toggle-btn"
        onClick={handleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        aria-label="切换主题"
        aria-haspopup="menu"
        aria-expanded={open}
        title="切换主题（可拖动）"
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
