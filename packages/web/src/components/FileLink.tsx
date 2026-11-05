import type { AnchorHTMLAttributes } from "react";
import { useFileLinks } from "../hooks/useFileLinks.js";

/** An anchor for a stored file. The link is refreshed when the owner reaches for it. */
export function FileLink({ url, children, ...anchor }: { url: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { link, refresh } = useFileLinks([url]);
  return <a {...anchor} href={link(url)} onPointerEnter={refresh} onFocus={refresh}>{children}</a>;
}
