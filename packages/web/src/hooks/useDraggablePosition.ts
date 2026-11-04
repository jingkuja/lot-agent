import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

/** Pointer travel (px) before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Keep the element at least this far from the viewport edges. */
export const EDGE_MARGIN = 8;

type Pos = { left: number; top: number };

function loadPos(storageKey: string): Pos | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (Number.isFinite(p?.left) && Number.isFinite(p?.top)) return p;
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

/**
 * Lets a `position: fixed` element be dragged away from its CSS anchor and remembers where it was left.
 * Spread `pointerHandlers` on the press target and call `consumeDrag()` first in its click handler.
 */
export function useDraggablePosition<T extends HTMLElement>(storageKey: string, onDrag?: () => void) {
  // null = default (CSS anchor); once dragged, an explicit left/top.
  const [pos, setPos] = useState<Pos | null>(() => loadPos(storageKey));
  const ref = useRef<T>(null);
  // Per-drag scratch: pointer start, grab offset within the element, whether it has crossed the threshold yet.
  const drag = useRef<{ startX: number; startY: number; offX: number; offY: number; moved: boolean } | null>(null);
  // Set on pointer-up of a real drag so the synthetic click that follows is ignored.
  const draggedRef = useRef(false);

  // Saved coordinates can belong to a larger window or another display.
  // Recover the default anchor before painting an off-screen element.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.left < EDGE_MARGIN || rect.top < EDGE_MARGIN ||
      rect.right > window.innerWidth - EDGE_MARGIN || rect.bottom > window.innerHeight - EDGE_MARGIN) {
      setPos(null);
    }
  }, []);

  // Persist the dragged position.
  useEffect(() => {
    try {
      if (pos) localStorage.setItem(storageKey, JSON.stringify(pos));
      else localStorage.removeItem(storageKey);
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [pos, storageKey]);

  // Keep the element on-screen if the window shrinks.
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

  const pointerHandlers = {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      const el = ref.current;
      if (!el || e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      draggedRef.current = false;
      drag.current = {
        startX: e.clientX,
        startY: e.clientY,
        offX: e.clientX - rect.left,
        offY: e.clientY - rect.top,
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el) return;
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.moved = true;
      onDrag?.();
      const r = el.getBoundingClientRect();
      setPos(clampToViewport(e.clientX - d.offX, e.clientY - d.offY, r.width, r.height));
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      const d = drag.current;
      drag.current = null;
      if (d?.moved) draggedRef.current = true;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    },
  };

  /** True when the current click merely ended a drag and should do nothing. */
  function consumeDrag() {
    const dragged = draggedRef.current;
    draggedRef.current = false;
    return dragged;
  }

  const style: CSSProperties | undefined = pos ? { left: pos.left, top: pos.top, right: "auto" } : undefined;
  return { ref, style, pointerHandlers, consumeDrag };
}
