import { DEFAULT_MARKETING_VIDEO_MODEL, MARKETING_VIDEO_PROFILES, marketingVideoProfile, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";

/** Model for new marketing clips, chosen by `MARKETING_VIDEO_MODEL`. An unknown id fails fast. */
export function activeMarketingVideoProfile(env: NodeJS.ProcessEnv = process.env): MarketingVideoProfile {
  const id = env.MARKETING_VIDEO_MODEL?.trim() || DEFAULT_MARKETING_VIDEO_MODEL;
  const profile = marketingVideoProfile(id);
  if (!profile) throw new Error(`MARKETING_VIDEO_MODEL=${id} 不受支持，可选：${MARKETING_VIDEO_PROFILES.map(item => item.modelId).join("、")}`);
  return profile;
}
