import { z } from "zod";

export const MarketingSourceSchema = z.object({ kind: z.enum(["text", "video"]) }).strict();
export type MarketingSource = z.infer<typeof MarketingSourceSchema>;

/** Shared token boundaries for pasted Chinese/English share text and Markdown.
 * Match whole URLs first so a video hostname inside a foreign URL is not a link. */
export function marketingSourceUrls(text: string): string[] {
  const tokens = text.match(/https?:\/\/[^\s<>"'“”‘’，。；、！（）()[\]{},;]+|(?<![\w@./+-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>"'“”‘’，。；、！（）()[\]{},;]+)?/gi) ?? [];
  return tokens.map(token => {
    const value = token.replace(/[.!?:]+$/u, "");
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  });
}

/** A routing hint, never a download allowlist. Homepages and profile CTAs are
 * text; only supported video paths and short shares require video evidence. */
export function marketingVideoPlatform(url: URL): "douyin" | "bilibili" | "xiaohongshu" | undefined {
  const host = url.hostname.toLowerCase(); const path = url.pathname.replace(/\/$/, "");
  if (["v.douyin.com", "b23.tv", "xhslink.com"].includes(host) && /^\/(?:[a-z]\/)?[A-Za-z0-9_-]{3,80}$/.test(path)) {
    return host === "v.douyin.com" ? "douyin" : host === "b23.tv" ? "bilibili" : "xiaohongshu";
  }
  if (["www.douyin.com", "douyin.com"].includes(host) && /^\/video\/\d{5,30}$/.test(path)
    || ["www.iesdouyin.com", "iesdouyin.com"].includes(host) && /^\/share\/video\/\d{5,30}$/.test(path)) return "douyin";
  if (["www.bilibili.com", "m.bilibili.com", "bilibili.com"].includes(host) && /^\/video\/BV[A-Za-z0-9]{10}$/.test(path)) return "bilibili";
  if (["www.xiaohongshu.com", "xiaohongshu.com"].includes(host) && /^\/(?:explore|discovery\/item)\/[a-fA-F0-9]{24}$/.test(path)) return "xiaohongshu";
}

export function marketingSourceKind(text: string): "text" | "video" {
  return marketingSourceUrls(text).some(raw => {
    try { return !!marketingVideoPlatform(new URL(raw)); } catch { return false; }
  }) ? "video" : "text";
}
