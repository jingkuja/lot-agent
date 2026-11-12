import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";

/** Well inside the server's six hours, so a link about to be used is never close to expiring. */
const REFRESH_AFTER_MS = 60 * 60_000;
const SIGNED_FILE = /\/static\/(documents|uploads|assets)\//;

/**
 * Stored file URLs stay as they are; private ones need a short-lived link from the server to open
 * outside an API call. `ready` is false until the first answer, so an image never loads a dead URL.
 */
export function useFileLinks(urls: string[]) {
  const key = urls.filter((url) => SIGNED_FILE.test(url)).join("\n");
  const [state, setState] = useState<{ key: string; links: Record<string, string> } | null>(null);
  const signedAt = useRef(0);

  const refresh = useCallback(() => {
    if (!key || Date.now() - signedAt.current < REFRESH_AFTER_MS) return;
    signedAt.current = Date.now();
    void api.getFileLinks(key.split("\n"))
      .then(({ links }) => setState({ key, links }))
      // Older files are public, so the stored URL is still the best answer.
      .catch(() => { signedAt.current = 0; setState({ key, links: {} }); });
  }, [key]);

  useEffect(() => { signedAt.current = 0; refresh(); }, [refresh]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const links = state?.key === key ? state.links : null;
  return { ready: !key || links !== null, link: (url: string) => links?.[url] ?? url, refresh };
}
