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
type ComicVideoProfile = {
  referenceImages: { total: number };
  referenceImage: ReferenceImage;
  imagePromptTag: MarketingVideoProfile["imagePromptTag"];
  shotMaxSeconds: number;
  promptMaxChars?: number;
  resolution?: "720p" | "768P";
};

const seedanceImage: ReferenceImage = {
  formats: ["image/jpeg", "image/png", "image/webp"], maxBytes: 30_000_000 - 1, minEdge: 300, maxEdge: 6000, minAspect: 0.4, maxAspect: 2.5,
};
const seedance = { referenceImage: seedanceImage, imagePromptTag: { prefix: "@Image", suffix: "", firstNumber: 1 }, resolution: "720p" } as const;
const videoModels = [
  {
    ids: ["doubao-seedance-2-5", "doubao-seedance-2.5", "doubao-seedance-2-5-260628"], label: "Seedance 2.5 标准版",
    profile: { ...seedance, shotMaxSeconds: 30, referenceImages: { total: 30 } },
  },
  {
    ids: ["doubao-seedance-2-0", "doubao-seedance-2.0", "doubao-seedance-2-0-260128"], label: "Seedance 2.0",
    profile: { ...seedance, shotMaxSeconds: 15, referenceImages: { total: 9 } },
  },
  {
    ids: ["minimax-video-h3", "MiniMax-H3", "MiniMax/MiniMax-H3"], label: "MiniMax H3",
    profile: {
      shotMaxSeconds: 15, referenceImages: { total: 9 }, resolution: "768P",
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

export function comicVideoProfile(modelId: string | null): ComicVideoProfile | undefined {
  const profile = comicVideoModel(modelId)?.profile;
  if (!profile) return undefined;
  return comicVideoModel(modelId)?.label === "MiniMax H3" ? { ...profile, promptMaxChars: 7000 } : profile;
}

export function comicVideoDurationSupported(durationMs: number, profile: Pick<ComicVideoProfile, "shotMaxSeconds">) {
  return durationMs % 1000 === 0 && durationMs >= 4000 && durationMs <= profile.shotMaxSeconds * 1000;
}

export function comicReferenceImageInvalid(profile: ComicVideoProfile, image: { mime: string; size: number; width: number; height: number }) {
  const max = profile.referenceImage.maxEdge;
  return Boolean((max && Math.max(image.width, image.height) > max) || marketingReferenceImageIssue(profile, image));
}
