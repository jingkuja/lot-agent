/** Extracts the `token` query param from a URL search string (e.g. a tokenhub
 *  `/?token=<jwt>` deep link). Returns null when absent or blank. */
export function readTokenFromUrl(search: string): string | null {
  const token = new URLSearchParams(search).get("token");
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
}

/** Removes the `token` param from the current URL (address bar + history entry)
 *  so the JWT does not linger in history/bookmarks/shares. No-op in non-browser. */
export function stripTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) return;
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}
