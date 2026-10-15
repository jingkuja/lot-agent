import { expect, it } from "vitest";
import { marketingSourceKind } from "./source.js";

it.each(["现磨咖啡", "欢迎到店 https://example.com/shop", "https://example.com https://shop.test", "https://bilibili.com.evil.test/video/123"])("keeps ordinary copy and website CTAs as text: %s", text => {
  expect(marketingSourceKind(text)).toBe("text");
});
it.each(["https://www.bilibili.com/video/BV1234567890", "分享 https://v.douyin.com/abc123/", "b23.tv/abc123", "https://xhslink.com/a/abc123", "https://example.com https://b23.tv/abc123"])("requires evidence for video shares: %s", text => {
  expect(marketingSourceKind(text)).toBe("video");
});
