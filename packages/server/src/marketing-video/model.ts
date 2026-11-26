import { DEFAULT_MARKETING_VIDEO_PROFILE, marketingDraftProfile, type MarketingDraft } from "@lot-agent/core/marketing-video";

export function activeMarketingVideoProfile() {
  return DEFAULT_MARKETING_VIDEO_PROFILE;
}

export function newMarketingVideoProfile(draft: Pick<MarketingDraft, "quality">) {
  return marketingDraftProfile(draft, activeMarketingVideoProfile());
}
