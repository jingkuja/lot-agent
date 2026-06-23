export type Theme = "light" | "dark";

export const DEFAULT_THEME: Theme = "light";

const STORAGE_KEY = "lot:theme";

/** Coerce an arbitrary stored value to a valid theme, defaulting to light. */
export function normalizeTheme(value: string | null | undefined): Theme {
  return value === "dark" || value === "light" ? value : DEFAULT_THEME;
}

/** Read the persisted theme (falls back to the default). */
export function getStoredTheme(): Theme {
  try {
    return normalizeTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persist the chosen theme. */
export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore storage failures (e.g. private mode)
  }
}

/** Apply the theme to the document so the CSS variables switch. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}
