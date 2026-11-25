import { marketingReferenceImageIssue } from "../marketing-video/models.js";
import type { MarketingVideoProfile } from "../marketing-video/models.js";

const imageTiers = [
  { label: "默认", ids: ["gpt-image-2.5-flare"] },
  { label: "旗舰", ids: ["gpt-image-2.5-sunburst"] },
  { label: "无限制出图", ids: ["linqu-image", "lingqu-image"] },
] as const;

export function comicImageTier(id: string | null | undefined) {
  return imageTiers.find(tier => tier.ids.some(model => model === id));
}

export function comicImageOptions<T extends { id: string }>(models: readonly T[]) {
  return imageTiers.flatMap(tier => {
    const model = tier.ids.map(id => models.find(item => item.id === id)).find(Boolean);
    return model ? [{ ...model, label: tier.label }] : [];
  });
}

export function selectComicImageModel(models: readonly { id: string }[], preferred?: string | null) {
  const options = comicImageOptions(models);
  const tier = comicImageTier(preferred);
  return (options.find(model => model.label === tier?.label) ?? options[0])?.id ?? null;
}

type ReferenceImage = MarketingVideoProfile["referenceImage"] & { maxEdge?: number };
export const comicVideoResolutions = ["480p", "720p", "768P", "1080p", "2K", "4k"] as const;
export type ComicVideoResolution = typeof comicVideoResolutions[number];
export const comicVideoAudioModes = ["silent_tts", "native_audio", "reference_audio"] as const;
export type ComicVideoAudioMode = typeof comicVideoAudioModes[number];
export type ComicVideoOperation = "reference" | "edit" | "extend";
export type ComicVideoProfile = {
  referenceImages: { total: number };
  referenceImage: ReferenceImage;
  imagePromptTag: MarketingVideoProfile["imagePromptTag"];
  shotMaxSeconds: number;
  promptMaxChars?: number;
  resolution: ComicVideoResolution;
  resolutions: readonly ComicVideoResolution[];
  adaptiveFrame?: boolean;
  referenceMedia: {
    count: number; totalFiles: number; audioOnly: boolean; videoBytes: number;
    minEdge: number; maxEdge: number; minFps: number; minPixels?: number; maxPixels?: number;
    movPcm: boolean;
  };
  operations: readonly ComicVideoOperation[];
  promptRecommendation?: { chineseChars: number; englishWords: number };
  promptLimitUnverified?: boolean;
};

const seedanceImage: ReferenceImage = {
  formats: ["image/jpeg", "image/png", "image/webp"], maxBytes: 30_000_000 - 1, minEdge: 300, maxEdge: 6000, minAspect: 0.4, maxAspect: 2.5,
};
const seedance = {
  referenceImage: seedanceImage, imagePromptTag: { prefix: "@Image", suffix: "", firstNumber: 1 }, resolution: "720p",
  resolutions: ["480p", "720p", "1080p", "4k"],
  promptRecommendation: { chineseChars: 500, englishWords: 1000 }, promptLimitUnverified: true,
} as const;
const seedanceMedia = { videoBytes: 200_000_000, minEdge: 300, maxEdge: 6000, minFps: 24, minPixels: 407696, maxPixels: 8847360, movPcm: true };
const videoModels = [
  {
    ids: ["doubao-seedance-2-5", "doubao-seedance-2.5", "doubao-seedance-2-5-260628"], label: "Seedance 2.5",
    profile: {
      ...seedance, adaptiveFrame: true, shotMaxSeconds: 30, referenceImages: { total: 30 }, operations: ["reference", "edit", "extend"],
      referenceMedia: { ...seedanceMedia, count: 10, totalFiles: 50, audioOnly: true },
    },
  },
  {
    ids: ["doubao-seedance-2-0", "doubao-seedance-2.0", "doubao-seedance-2-0-260128"], label: "Seedance 2.0",
    profile: {
      ...seedance, shotMaxSeconds: 15, referenceImages: { total: 9 }, operations: ["reference", "extend"],
      referenceMedia: { ...seedanceMedia, maxPixels: 8295044, count: 3, totalFiles: 15, audioOnly: false },
    },
  },
  {
    ids: ["minimax-video-h3", "MiniMax-H3", "MiniMax/MiniMax-H3"], label: "MiniMax H3",
    profile: {
      shotMaxSeconds: 15, adaptiveFrame: true, referenceImages: { total: 9 }, resolution: "768P", resolutions: ["768P", "2K"], operations: ["reference"],
      referenceMedia: { count: 3, totalFiles: 12, audioOnly: false, videoBytes: 50_000_000, minEdge: 256, maxEdge: 5760, minFps: 23.976, movPcm: false },
      imagePromptTag: { prefix: "", suffix: "", firstNumber: 1 },
      referenceImage: { ...seedanceImage, maxBytes: 30_000_000, minEdge: 256, maxEdge: 5760 },
    },
  },
] as const satisfies readonly { ids: readonly string[]; label: string; profile: ComicVideoProfile }[];

export function comicVideoModel(id: string | null | undefined) {
  return videoModels.find(model => model.ids.some(alias => alias.toLowerCase() === id?.toLowerCase()));
}

export function comicVideoOptions<T extends { id: string }>(models: readonly T[], preferred?: string | null) {
  return videoModels.flatMap(definition => {
    const matches = models.filter(model => comicVideoModel(model.id) === definition);
    const model = matches.find(item => item.id === preferred) ?? matches[0];
    return model ? [{ ...model, label: definition.label }] : [];
  });
}

/** Video model of a new episode: the preferred one if the account can use it, else Seedance 2.0, else the first listed. */
export function selectComicVideoModel(models: readonly { id: string }[], preferred?: string | null) {
  const options = comicVideoOptions(models, preferred);
  return (options.find(model => model.id === preferred) ?? options.find(model => model.label === "Seedance 2.0") ?? options[0])?.id ?? null;
}

export function comicVideoProfile(modelId: string | null): ComicVideoProfile | undefined {
  const profile = comicVideoModel(modelId)?.profile;
  if (!profile) return undefined;
  if (modelId?.toLowerCase() === "minimax/minimax-h3") return { ...profile, promptMaxChars: 7000 };
  return comicVideoModel(modelId)?.label === "MiniMax H3" ? { ...profile, promptLimitUnverified: true } : profile;
}

export function comicVideoDurationSupported(durationMs: number, profile: Pick<ComicVideoProfile, "shotMaxSeconds">) {
  return durationMs % 1000 === 0 && durationMs >= 4000 && durationMs <= profile.shotMaxSeconds * 1000;
}

export function comicReferenceImageInvalid(profile: ComicVideoProfile, image: { mime: string; size: number; width: number; height: number }) {
  const max = profile.referenceImage.maxEdge;
  return Boolean((max && Math.max(image.width, image.height) > max) || marketingReferenceImageIssue(profile, image));
}

export function resolveComicVideoAudioMode(
  audioMode: ComicVideoAudioMode | undefined,
  hasReferenceAudio: boolean,
): ComicVideoAudioMode {
  return audioMode ?? (hasReferenceAudio ? "reference_audio" : "silent_tts");
}

/** Cross-model safe common denominator across Seedance 2.5, Seedance 2.0, and MiniMax H3. */
export const COMIC_VIDEO_SAFE_COMMON_LIMITS = {
  minSeconds: 4,
  maxSeconds: 15,
  maxImages: 9,
  maxTotalFiles: 12,
  maxAudioCount: 3,
  maxVideoCount: 3,
  maxAudioTotalSeconds: 15,
  maxVideoTotalSeconds: 15,
  audioOnlyAllowed: false,
} as const;

const resolutionRank: Record<ComicVideoResolution, number> = {
  "480p": 480,
  "720p": 720,
  "768P": 768,
  "1080p": 1080,
  "2K": 1440,
  "4k": 2160,
};

/** Maps a resolution to the nearest option supported by the target video model. */
export function mapComicVideoResolution(
  resolution: ComicVideoResolution | undefined,
  targetProfile: Pick<ComicVideoProfile, "resolutions" | "resolution">,
): ComicVideoResolution | undefined {
  if (!resolution) return undefined;
  if (targetProfile.resolutions.includes(resolution)) return resolution;
  const preferred: Partial<Record<ComicVideoResolution, readonly ComicVideoResolution[]>> = {
    "480p": ["768P", "720p"],
    "720p": ["768P", "1080p", "480p"],
    "768P": ["720p", "1080p"],
    "1080p": ["2K", "768P", "720p"],
    "2K": ["1080p", "4k", "720p"],
    "4k": ["2K", "1080p"],
  };
  for (const candidate of preferred[resolution] ?? []) {
    if (targetProfile.resolutions.includes(candidate)) return candidate;
  }
  const sourceRank = resolutionRank[resolution];
  return [...targetProfile.resolutions].sort(
    (a, b) => Math.abs(resolutionRank[a] - sourceRank) - Math.abs(resolutionRank[b] - sourceRank),
  )[0] ?? targetProfile.resolution;
}
