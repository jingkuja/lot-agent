import { marketingAssetIds, marketingReferenceImageIssue, type MarketingDraft, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { validateTwinFile } from "../digital-twin/media.js";
import { readImageSize, klingReferenceVideoIssue, readMediaDuration, readMediaMetadata } from "../../lib/video-references.js";
import { isKlingModel } from "../../lib/model-filter.js";

export type MaterialSlot = keyof MarketingDraft["assets"];
export type Material = { id: string; url: string; name: string; mime: string; issue?: "unsupported" };

/** Slots that hold up to three reference images. */
export const isImageSlot = (slot: MaterialSlot): slot is "portrait" | "background" | "scene" => ["portrait", "background", "scene"].includes(slot);

/** Background and scene images share one limit of three. */
export function imageCount(slot: MaterialSlot, draft: MarketingDraft) {
  return slot === "background" || slot === "scene"
    ? marketingAssetIds(draft.assets.background).length + marketingAssetIds(draft.assets.scene).length
    : marketingAssetIds(draft.assets[slot]).length;
}

/** The stored material for an ID, including drafts that stored a single slot entry. */
export function materialFor(materials: Record<string, Material>, slot: string, id: string) {
  return materials[id] ?? (materials[slot]?.id === id ? materials[slot] : undefined);
}

/** Check a file before upload. The server re-checks the real file against the active
 * model before any submission. */
export async function checkMaterial(file: File, slot: MaterialSlot, draft: MarketingDraft, profile: MarketingVideoProfile) {
  if (isImageSlot(slot) && imageCount(slot, draft) >= 3) throw new Error("人物或场景区域各最多 3 张。");
  if (isImageSlot(slot) || slot === "voice") {
    await validateTwinFile(file, slot === "voice" ? "voice" : "portrait");
    const issue = isImageSlot(slot) ? await readImageSize(file).then(size => marketingReferenceImageIssue(profile, { mime: file.type, size: file.size, ...size }),
      (e: unknown) => e instanceof Error ? e.message : "无法读取图片尺寸，请更换图片") : undefined;
    if (issue) throw new Error(issue);
  } else if (slot === "video") {
    if (draft.assets.video) throw new Error("参考视频最多 1 个，请先移除已有视频。");
    if (!file.size || file.size > 150 * 1024 * 1024 || !["video/mp4", "video/quicktime"].includes(file.type)) throw new Error("参考视频支持 MP4、MOV，最大 150 MB。");
    const metadata = await readMediaMetadata(file);
    if (!metadata.width || !metadata.height) throw new Error("无法读取参考视频分辨率，请更换文件");
    const issue = isKlingModel(profile.modelId) ? klingReferenceVideoIssue(file, metadata) : undefined;
    if (issue) throw new Error(issue);
  } else {
    if (!file.size || file.size > 30 * 1024 * 1024 || !["audio/mpeg", "audio/wav", "audio/mp4"].includes(file.type)) throw new Error("背景音乐支持 MP3、WAV、M4A，最大 30 MB。");
    if (await readMediaDuration(file) > 600) throw new Error("背景音乐最长 10 分钟。");
  }
}

/** Check a local reference video for analysis before upload. */
export async function checkReferenceVideo(file: File) {
  if (!file.size || file.size > 100 * 1024 * 1024 || !["video/mp4", "video/quicktime", "video/webm"].includes(file.type)) throw new Error("本地爆款视频支持 MP4、MOV、WebM，最大 100 MB，最长 180 秒，最高 1080p。");
  const duration = await readMediaDuration(file);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw new Error("参考视频最长 180 秒。");
}
