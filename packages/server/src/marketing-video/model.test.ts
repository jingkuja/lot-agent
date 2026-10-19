import { expect, it } from "vitest";
import { activeMarketingVideoProfile } from "./model.js";

it("selects the marketing clip model from MARKETING_VIDEO_MODEL", () => {
  expect(activeMarketingVideoProfile({}).modelId).toBe("grok-imagine-video-1.5");
  expect(activeMarketingVideoProfile({ MARKETING_VIDEO_MODEL: " kling-video-v3-omni " }).modelId).toBe("kling-video-v3-omni");
  expect(() => activeMarketingVideoProfile({ MARKETING_VIDEO_MODEL: "doubao-seedance-2-5" })).toThrow("不受支持");
});
