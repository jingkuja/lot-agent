import { expect, it } from "vitest";
import { marketingSourceKind } from "./source.js";

it.each(["现磨咖啡", "欢迎到店 https://example.com/shop", "https://example.com https://shop.test", "https://bilibili.com.evil.test/video/123"])("keeps ordinary copy and website CTAs as text: %s", text => {
  expect(marketingSourceKind(text)).toBe("text");
});
it.each(["https://www.bilibili.com/video/BV1234567890", "分享 https://v.douyin.com/abc123/", "b23.tv/abc123", "https://xhslink.com/a/abc123", "https://example.com https://b23.tv/abc123"])("requires evidence for video shares: %s", text => {
  expect(marketingSourceKind(text)).toBe("video");
});
it.each(["参考：", "参考:", "参考，", "参考,", "参考“", "参考\"", "参考'", "[分享标题]("])("recognizes share links adjacent to %s", prefix => {
  for (const link of ["https://b23.tv/abc123", "b23.tv/abc123"]) expect(marketingSourceKind(`${prefix}${link}）`)).toBe("video");
});
it.each(["https://www.bilibili.com", "https://www.douyin.com/user/123456", "https://www.xiaohongshu.com/user/profile/123456", "https://evil.test/b23.tv/abc123", "https://b23.tv.evil.test/abc123", "https://example.com/?next=https://b23.tv/abc123"])("keeps non-video links as text: %s", text => {
  expect(marketingSourceKind(text)).toBe("text");
});
