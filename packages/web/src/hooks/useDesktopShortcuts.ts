import { useEffect, useRef } from "react";
import { toggleTheme } from "../lib/theme.js";

export interface DesktopShortcutHandlers {
  /** Cmd/Ctrl+N — start a new chat with the agent currently on screen. */
  onNewChat: () => void;
}

/**
 * Desktop-only app shortcuts (active only inside the Electron shell — in a
 * plain browser we leave Cmd+N etc. to the browser itself). Window-scoped on
 * purpose: no global shortcuts that would steal keys from other apps.
 *
 *   Cmd/Ctrl+N         新会话
 *   Cmd/Ctrl+Shift+T   切换深浅主题
 */
export function useDesktopShortcuts(handlers: DesktopShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (typeof window === "undefined" || !window.lotDesktop) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handlersRef.current.onNewChat();
      } else if (key === "t" && e.shiftKey) {
        e.preventDefault();
        toggleTheme();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
