import { marketingAssetIds, marketingMaterialRule, marketingNativeSpeech, marketingReferenceImageIssue, MARKETING_MATERIAL_RULES,
  type MarketingDraft, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import type { DB } from "../db/database.js";
import { AnalysisError } from "../marketing-analysis/errors.js";
import { ownedAnalysisUpload } from "../marketing-analysis/uploads.js";
import { signPrivateMaterial } from "../generation/private-materials.js";
import { readImageInfo } from "./image-size.js";
import { inspectMedia, ownedAssetPath } from "./media.js";
import { marketingImageReferences } from "./prompt.js";
import { MarketingError } from "./repository.js";

/** A draft material as the studio shows it. `issue` marks a file that an earlier version accepted
 * and new generation no longer does. */
export interface OwnedMaterial { id: string; url: string; name: string; mime: string; issue?: "unsupported" }

export interface OwnedMaterialOptions {
  /** Skip assets that no longer exist instead of failing. */
  allowMissing?: boolean;
  /** Files this draft already used stay readable even when new submissions refuse them. */
  historicalDraft?: MarketingDraft;
  /** Sign short-lived links for the browser instead of returning the stored URL. */
  preview?: boolean;
}

/** Ownership and file checks of a draft's materials. */
export class MarketingMaterials {
  constructor(private readonly db: Pick<DB, "pool" | "getAsset" | "protectMarketingUpload">, private readonly dataRoot: string) {}

  /** The owner's materials of `draft`, keyed by asset ID and, for the first one of a slot, by slot. */
  async owned(owner: string, draft: MarketingDraft, options: OwnedMaterialOptions = {}): Promise<Record<string, OwnedMaterial>> {
    const { allowMissing = false, historicalDraft, preview = false } = options;
    if (draft.referenceUpload && draft.referenceUpload.id !== historicalDraft?.referenceUpload?.id) {
      try { await ownedAnalysisUpload(this.db.pool, owner, draft.referenceUpload.id); }
      catch (error) {
        if (!(error instanceof AnalysisError)) throw error;
        const message = error.code === "UPLOAD_EXPIRED" ? "本地视频已过期，请重新上传。" : "本地视频不存在，请重新上传。";
        throw new MarketingError(message, error.status === 404 ? 404 : 409);
      }
    }
    const result: Record<string, OwnedMaterial> = {};
    for (const [slot, value] of Object.entries(draft.assets)) {
      for (const id of marketingAssetIds(value)) {
        const asset = await this.db.getAsset(id);
        if (asset && asset.user_id !== owner) throw new MarketingError("素材不存在", 404);
        if (!asset) {
          if (allowMissing) continue;
          throw new MarketingError("素材不存在", 404);
        }
        const rule = marketingMaterialRule(slot);
        const unsupported = !rule.formats.includes(asset.mime) || Number(asset.size_bytes) > rule.maxBytes;
        const used = marketingAssetIds(historicalDraft?.assets[slot as keyof MarketingDraft["assets"]]).includes(id);
        if (unsupported && !used) throw new MarketingError("素材格式或大小不支持");
        if (asset.type === "upload" && !asset.is_private) {
          await this.db.protectMarketingUpload(id, owner);
          asset.is_private = true;
        }
        result[id] = { id, url: preview ? signPrivateMaterial(asset) : asset.url, name: asset.original_name || slot, mime: asset.mime,
          ...(unsupported ? { issue: "unsupported" as const } : {}) };
        result[slot] ??= result[id];
      }
    }
    return result;
  }

  /** Checks before any clip is paid for: owned and supported files, the real format and size of each
   * submitted image, the reference video's limits and the length of the voice sample. */
  async check(owner: string, draft: MarketingDraft, profile: MarketingVideoProfile, inputVersion: number, needsSubmission: boolean, signal: AbortSignal) {
    const assets = await this.owned(owner, draft, { allowMissing: !needsSubmission, historicalDraft: needsSubmission ? undefined : draft });
    // The stored MIME is the client's claim and the draft may predate the active
    // model, so check each submitted image's real format and size against it here.
    if (needsSubmission && inputVersion >= 2) {
      for (const { assetId } of marketingImageReferences(draft)) {
        const asset = (await this.db.getAsset(assetId))!;
        const info = await readImageInfo(await ownedAssetPath(this.dataRoot, asset));
        const image = { mime: info?.mime ?? "", size: Number(asset.size_bytes), width: info?.width ?? 0, height: info?.height ?? 0 };
        const issue = marketingReferenceImageIssue(profile, image);
        if (issue) throw new MarketingError(issue);
      }
    }
    if (needsSubmission && assets.video) await this.checkReferenceVideo(assets.video.id, profile, signal);
    // A voice sample only guides the model's own speech; twin narration and silent renders ignore it.
    if (assets.voice && needsSubmission && marketingNativeSpeech(draft)) {
      const { minSeconds, maxSeconds } = MARKETING_MATERIAL_RULES.voice;
      const info = await this.inspect(assets.voice.id, signal);
      if (!info.audio || info.duration < minSeconds || info.duration > maxSeconds) throw new MarketingError(`声音样例时长需为 ${minSeconds}–${maxSeconds} 秒`);
    }
    if (assets.music && !(await this.inspect(assets.music.id, signal)).audio) throw new MarketingError("背景音乐不含音轨");
    return assets;
  }

  private async inspect(assetId: string, signal: AbortSignal) {
    return inspectMedia(await ownedAssetPath(this.dataRoot, (await this.db.getAsset(assetId))!), signal);
  }

  private async checkReferenceVideo(assetId: string, profile: MarketingVideoProfile, signal: AbortSignal) {
    const info = await this.inspect(assetId, signal);
    if (!info.video) throw new MarketingError("参考视频无法读取画面，请重新上传。");
    const limits = profile.referenceVideo;
    if (!limits) return;
    const shortEdge = Math.min(info.width, info.height), longEdge = Math.max(info.width, info.height), aspect = info.width / info.height;
    const outside = info.duration < limits.minSeconds || info.duration > limits.maxSeconds
      || !Number.isFinite(info.fps) || info.fps < limits.minFps || info.fps > limits.maxFps
      || shortEdge < limits.minEdge || longEdge > limits.maxEdge || info.width * info.height > limits.maxPixels
      || aspect < limits.minAspect || aspect > limits.maxAspect;
    if (outside) {
      const { minSeconds, maxSeconds, minFps, maxFps, minEdge, maxEdge, maxPixels, minAspect, maxAspect } = limits;
      throw new MarketingError(`参考视频需为 ${minSeconds}–${maxSeconds} 秒、${minFps}–${maxFps} fps，宽高各 ${minEdge}–${maxEdge} 像素，总像素不超过 ${maxPixels}，宽高比 ${minAspect}–${maxAspect}。`);
    }
  }
}
