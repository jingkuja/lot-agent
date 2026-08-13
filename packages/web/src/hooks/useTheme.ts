import { useCallback, useEffect, useState } from "react";
import { type Theme, getStoredTheme, storeTheme, applyTheme, THEME_SYNC_EVENT } from "../lib/theme.js";

/**
 * Theme state synced to <html data-theme> and localStorage.
 * Initial value matches the pre-paint script in index.html, so the first
 * render agrees with what the user already sees (no flash, no flip).
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  // Keep the DOM + storage in sync whenever the theme changes.
  useEffect(() => {
    applyTheme(theme);
    storeTheme(theme);
  }, [theme]);

  // Re-sync when the theme is changed outside this hook instance (e.g. the
  // desktop theme shortcut calling `toggleTheme()` in lib/theme).
  useEffect(() => {
    const sync = () => setThemeState(getStoredTheme());
    window.addEventListener(THEME_SYNC_EVENT, sync);
    return () => window.removeEventListener(THEME_SYNC_EVENT, sync);
  }, []);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);

  return { theme, setTheme };
}
