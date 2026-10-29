import { useRef } from "react";

/** Each response signs private videos anew; a link is kept this long, well inside the server's six-hour signature. */
export const SIGNED_LINK_REUSE_MS = 60 * 60_000;
export interface KeptLink { url: string; at: number }

/** The file a signed link points to, without its signature. */
export const linkPath = (url: string) => url.split(/[?#]/)[0];

/** The link to show: the kept one while it points to the same file and is fresh, else the new one. */
export function keepLink(kept: KeptLink | undefined, url: string, now: number): KeptLink {
  return kept && linkPath(kept.url) === linkPath(url) && now - kept.at < SIGNED_LINK_REUSE_MS ? kept : { url, at: now };
}

/** A signed video link that stays the same across responses for the same file, so a player is not reloaded
 * whenever the draft is saved. */
export function useSignedLink(url: string | undefined) {
  const kept = useRef<KeptLink | undefined>(undefined);
  if (!url) return url;
  kept.current = keepLink(kept.current, url, Date.now());
  return kept.current.url;
}
