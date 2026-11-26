import { expect, it } from "vitest";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { activeMarketingVideoProfile, newMarketingVideoProfile } from "./model.js";

it("makes 720p clips with Seedance 2.0 and 1080p clips with Seedance 2.5", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const model = (draft: unknown) => newMarketingVideoProfile(MarketingDraftSchema.parse(draft)).modelId;
  expect(activeMarketingVideoProfile().modelId).toBe("doubao-seedance-2-0");
  expect(model({ assets: { portrait: id } })).toBe("doubao-seedance-2-0");
  expect(model({ assets: { video: id } })).toBe("doubao-seedance-2-0");
  expect(model({ quality: "1080p" })).toBe("doubao-seedance-2-5");
  expect(model({ quality: "1080p", assets: { video: id } })).toBe("doubao-seedance-2-5");
});
