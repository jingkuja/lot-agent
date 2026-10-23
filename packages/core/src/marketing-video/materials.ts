// Upload rules of the studio's material slots. The browser checks a file before upload and the
// server checks the stored asset before any clip is paid for, both against these values.
// Reference images also follow the clip model's own contract (`MarketingVideoProfile.referenceImage`).

const MB = 1024 * 1024;
const AUDIO_FORMATS = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4"] as const;

export interface MarketingMaterialRule {
  formats: readonly string[];
  maxBytes: number;
  minSeconds?: number;
  maxSeconds?: number;
}

export const MARKETING_MATERIAL_RULES = {
  /** A generation reference video for motion and composition. */
  video: { formats: ["video/mp4", "video/quicktime"], maxBytes: 150 * MB },
  /** Background music, mixed in locally. */
  music: { formats: AUDIO_FORMATS, maxBytes: 30 * MB, maxSeconds: 600 },
  /** A voice sample for the model's own speech. */
  voice: { formats: AUDIO_FORMATS, maxBytes: 15 * MB, minSeconds: 2, maxSeconds: 15 },
  /** Presenter, product, background and scene images. */
  image: { formats: ["image/jpeg", "image/png", "image/webp"], maxBytes: 20 * MB },
} as const satisfies Record<string, MarketingMaterialRule>;

export type MarketingMaterialKind = keyof typeof MARKETING_MATERIAL_RULES;

/** The rule of a draft asset slot; every image slot shares one. */
export function marketingMaterialRule(slot: string): MarketingMaterialRule {
  return MARKETING_MATERIAL_RULES[slot === "video" || slot === "music" || slot === "voice" ? slot : "image"];
}

/** Whole megabytes of a byte limit, as shown to users. */
export const marketingMegabytes = (bytes: number) => Math.round(bytes / MB);
