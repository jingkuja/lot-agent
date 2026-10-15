import { z } from "zod";

export const MarketingSourceSchema = z.object({ kind: z.enum(["text", "video"]) }).strict();

/** A routing hint, never a download allowlist. Ordinary website CTAs remain
 * text. Recognize protocol-less shares so they cannot reach text synthesis. */
export function marketingSourceKind(text: string): "text" | "video" {
  return /(?:^|[\s(（])(?:https?:\/\/)?(?:(?:www\.|m\.)?(?:douyin\.com|iesdouyin\.com|bilibili\.com|xiaohongshu\.com)|v\.douyin\.com|b23\.tv|xhslink\.com)(?=[/:\s]|$)/i.test(text)
    ? "video" : "text";
}
