import { MARKETING_IMAGE_SLOTS, MARKETING_MATERIAL_RULES, marketingAssetIds, marketingImageCount, marketingImageLimitError, marketingImageSection,
  marketingMegabytes, marketingReferenceImageIssue, type MarketingDraft, type MarketingImageSlot, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { ANALYSIS_LIMITS, ANALYSIS_UPLOAD_MIMES } from "@lot-agent/core/marketing-analysis";
import { validateTwinFile } from "../digital-twin/media.js";
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

/** Check a file before upload. The server re-checks the real file against the active
 * model before any submission. */
export async function checkMaterial(file: File, slot: MaterialSlot, draft: MarketingDraft, profile: MarketingVideoProfile) {
  const limitError = isImageSlot(slot) ? imageLimitError(slot, 1, draft, profile) : "";
  if (limitError) throw new Error(limitError);
  if (isImageSlot(slot) || slot === "voice") {
    await validateTwinFile(file, slot === "voice" ? "voice" : "portrait");
    const issue = isImageSlot(slot) ? await readImageSize(file).then(size => marketingReferenceImageIssue(profile, { mime: file.type, size: file.size, ...size }),
      (e: unknown) => e instanceof Error ? e.message : "无法读取图片尺寸，请更换图片") : undefined;
    if (issue) throw new Error(issue);
  } else if (slot === "video") {
    if (draft.assets.video) throw new Error("参考视频最多 1 个，请先移除已有视频。");
    if (!fitsRule(file, MARKETING_MATERIAL_RULES.video)) throw new Error(referenceVideoRule());
    const metadata = await readMediaMetadata(file);
    if (!metadata.width || !metadata.height) throw new Error("无法读取参考视频分辨率，请更换文件");
    const issue = isKlingModel(profile.modelId) ? klingReferenceVideoIssue(file, metadata) : undefined;
    if (issue) throw new Error(issue);
  } else {
    const { maxBytes, maxSeconds } = MARKETING_MATERIAL_RULES.music;
    if (!fitsRule(file, MARKETING_MATERIAL_RULES.music)) throw new Error(`背景音乐支持 MP3、WAV、M4A，最大 ${marketingMegabytes(maxBytes)} MB。`);
    if (await readMediaDuration(file) > maxSeconds) throw new Error(`背景音乐最长 ${maxSeconds / 60} 分钟。`);
  }
}

const fitsRule = (file: File, rule: { formats: readonly string[]; maxBytes: number }) =>
  !!file.size && file.size <= rule.maxBytes && rule.formats.includes(file.type);
/** Formats and size of a generation reference video, shown as a hint and as the upload error. */
export const referenceVideoRule = () => `参考视频支持 MP4、MOV，最大 ${marketingMegabytes(MARKETING_MATERIAL_RULES.video.maxBytes)} MB。`;
/** Formats and limits of a local video for analysis, shown as a hint and as the upload error. */
export const analysisUploadRule = () =>
  `本地爆款视频支持 MP4、MOV、WebM，最大 ${marketingMegabytes(ANALYSIS_LIMITS.downloadBytes)} MB，最长 ${ANALYSIS_LIMITS.durationMs / 1000} 秒，最高 1080p。`;

/** Check a local reference video for analysis before upload. */
export async function checkReferenceVideo(file: File) {
  if (!fitsRule(file, { formats: ANALYSIS_UPLOAD_MIMES, maxBytes: ANALYSIS_LIMITS.downloadBytes })) throw new Error(analysisUploadRule());
  const duration = await readMediaDuration(file);
  const maxSeconds = ANALYSIS_LIMITS.durationMs / 1000;
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxSeconds) throw new Error(`参考视频最长 ${maxSeconds} 秒。`);
}
