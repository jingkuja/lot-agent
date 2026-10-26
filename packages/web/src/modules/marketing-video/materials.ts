import { MARKETING_IMAGE_SLOTS, MARKETING_MATERIAL_RULES, marketingAssetIds, marketingFormatNames, marketingImageCount, marketingImageLimitError,
  marketingImageSection, marketingMaterialRule, marketingMegabytes, marketingReferenceImageIssue, type MarketingDraft, type MarketingImageSlot,
  type MarketingMaterialRule, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { ANALYSIS_LIMITS, ANALYSIS_UPLOAD_MIMES } from "@lot-agent/core/marketing-analysis";
import { readImageSize, klingReferenceVideoIssue, readMediaDuration, readMediaMetadata } from "../../lib/video-references.js";
import { isKlingModel } from "../../lib/model-filter.js";

export type MaterialSlot = keyof MarketingDraft["assets"];
export type Material = { id: string; url: string; name: string; mime: string; issue?: "unsupported" };

/** Slots that hold several reference images. */
export const isImageSlot = (slot: MaterialSlot): slot is MarketingImageSlot => (MARKETING_IMAGE_SLOTS as readonly string[]).includes(slot);

/** Images selected in the slot's section; background and scene share one section. */
export const imageCount = (slot: MarketingImageSlot, draft: MarketingDraft) => marketingImageCount(draft.assets, marketingImageSection(slot));

/** The model's limit for the slot's section, and whether the section or all sections are full. */
export function imageRoom(slot: MarketingImageSlot, draft: MarketingDraft, profile: MarketingVideoProfile) {
  const limit = profile.referenceImages[marketingImageSection(slot)];
  return { limit, full: imageCount(slot, draft) >= limit || marketingImageCount(draft.assets) >= profile.referenceImages.total };
}

/** Error when adding `added` images to the slot would pass the model's limits. */
export const imageLimitError = (slot: MarketingImageSlot, added: number, draft: MarketingDraft, profile: MarketingVideoProfile) =>
  marketingImageLimitError({ ...draft.assets, [slot]: [...marketingAssetIds(draft.assets[slot]), ...Array.from({ length: added }, () => "")] }, profile);

/** The stored material for an ID, including drafts that stored a single slot entry. */
export function materialFor(materials: Record<string, Material>, slot: string, id: string) {
  return materials[id] ?? (materials[slot]?.id === id ? materials[slot] : undefined);
}

/** Check a file before upload against the same rules the server applies. The server re-checks the
 * real file against the active model before any submission. */
export async function checkMaterial(file: File, slot: MaterialSlot, draft: MarketingDraft, profile: MarketingVideoProfile) {
  const limitError = isImageSlot(slot) ? imageLimitError(slot, 1, draft, profile) : "";
  if (limitError) throw new Error(limitError);
  if (slot === "video" && draft.assets.video) throw new Error("动作参考视频最多 1 个，请先移除已有视频。");
  if (!fitsRule(file, marketingMaterialRule(slot))) throw new Error(materialRule(slot));
  if (isImageSlot(slot)) {
    const issue = await readImageSize(file).then(size => marketingReferenceImageIssue(profile, { mime: file.type, size: file.size, ...size }),
      (e: unknown) => e instanceof Error ? e.message : "无法读取图片尺寸，请更换图片");
    if (issue) throw new Error(issue);
  } else if (slot === "video") {
    const metadata = await readMediaMetadata(file);
    if (!metadata.width || !metadata.height) throw new Error("无法读取动作参考视频分辨率，请更换文件");
    const issue = isKlingModel(profile.modelId) ? klingReferenceVideoIssue(file, metadata) : undefined;
    if (issue) throw new Error(issue);
  } else if (slot === "voice") {
    const { minSeconds, maxSeconds } = MARKETING_MATERIAL_RULES.voice;
    const duration = await readMediaDuration(file);
    if (!Number.isFinite(duration) || duration < minSeconds || duration > maxSeconds) throw new Error(`声音样例时长需为 ${minSeconds}–${maxSeconds} 秒`);
  } else if (await readMediaDuration(file) > MARKETING_MATERIAL_RULES.music.maxSeconds) {
    throw new Error(`背景音乐最长 ${MARKETING_MATERIAL_RULES.music.maxSeconds / 60} 分钟。`);
  }
}

const fitsRule = (file: File, rule: Pick<MarketingMaterialRule, "formats" | "maxBytes">) =>
  !!file.size && file.size <= rule.maxBytes && rule.formats.includes(file.type);
/** File types the slot's file picker offers. */
export const materialAccept = (slot: MaterialSlot) => marketingMaterialRule(slot).formats.join(",");
/** Formats and size of a slot's files, shown as a hint and as the upload error. */
export function materialRule(slot: MaterialSlot) {
  const { formats, maxBytes } = marketingMaterialRule(slot);
  const names = marketingFormatNames(formats), megabytes = marketingMegabytes(maxBytes);
  if (slot === "video") return `动作参考视频支持 ${names}，最大 ${megabytes} MB。`;
  if (slot === "music") return `背景音乐支持 ${names}，最大 ${megabytes} MB。`;
  if (slot === "voice") return `声音样例支持 ${names}，最大 ${megabytes} MB。`;
  return `图片支持 ${names}，最大 ${megabytes} MB。`;
}
/** Upload label of the voice sample, with its length limits. */
export const voiceUploadLabel = () => `上传声音样例（${MARKETING_MATERIAL_RULES.voice.minSeconds}–${MARKETING_MATERIAL_RULES.voice.maxSeconds} 秒）`;
/** Formats and limits of a local video for analysis, shown as a hint and as the upload error. */
export const analysisUploadRule = () =>
  `本地爆款视频支持 ${marketingFormatNames(ANALYSIS_UPLOAD_MIMES)}，最大 ${marketingMegabytes(ANALYSIS_LIMITS.downloadBytes)} MB，最长 ${ANALYSIS_LIMITS.durationMs / 1000} 秒，最高 1080p。`;

/** Check a local reference video for analysis before upload. */
export async function checkReferenceVideo(file: File) {
  if (!fitsRule(file, { formats: ANALYSIS_UPLOAD_MIMES, maxBytes: ANALYSIS_LIMITS.downloadBytes })) throw new Error(analysisUploadRule());
  const duration = await readMediaDuration(file);
  const maxSeconds = ANALYSIS_LIMITS.durationMs / 1000;
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxSeconds) throw new Error(`爆款视频最长 ${maxSeconds} 秒。`);
}
