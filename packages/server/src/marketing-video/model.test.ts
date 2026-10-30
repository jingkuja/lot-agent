import { expect, it } from "vitest";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { activeMarketingVideoProfile, newMarketingVideoProfile } from "./model.js";

it("selects the marketing clip model from MARKETING_VIDEO_MODEL", () => {
  expect(activeMarketingVideoProfile({}).modelId).toBe("grok-imagine-video-1.5");
  expect(activeMarketingVideoProfile({ MARKETING_VIDEO_MODEL: " kling-video-v3-omni " }).modelId).toBe("kling-video-v3-omni");
  expect(() => activeMarketingVideoProfile({ MARKETING_VIDEO_MODEL: "doubao-seedance-2-0" })).toThrow("不受支持");
});

it("makes 1080p videos and videos with a reference video with Seedance 2.5, the rest with the configured model", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const model = (draft: unknown, env = {}) => newMarketingVideoProfile(MarketingDraftSchema.parse(draft), env).modelId;
  expect(model({})).toBe("grok-imagine-video-1.5");
  expect(model({ assets: { portrait: id } })).toBe("grok-imagine-video-1.5");
  expect(model({ assets: { portrait: id } }, { MARKETING_VIDEO_MODEL: "kling-video-v3-omni" })).toBe("kling-video-v3-omni");
  expect(model({ quality: "1080p" })).toBe("doubao-seedance-2-5");
  expect(model({ quality: "1080p", assets: { portrait: id } }, { MARKETING_VIDEO_MODEL: "kling-video-v3-omni" })).toBe("doubao-seedance-2-5");
  expect(model({ assets: { video: id } })).toBe("doubao-seedance-2-5");
  expect(model({ quality: "1080p", assets: { video: id } })).toBe("doubao-seedance-2-5");
});
