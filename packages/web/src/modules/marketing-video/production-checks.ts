import { marketingAssetIds, marketingImageCount, marketingNarrationFits, marketingReferenceError, marketingStoryboardAudioMismatch, marketingVoiceover,
  type MarketingDraft, type MarketingNarrationClip, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import type { ConfirmRequest } from "./ConfirmDialog.js";
import { materialFor, type Material } from "./materials.js";

/** What this server can do (`GET /marketing-videos/capabilities`). `subtitles`: captions can be burned
 * in here, which every new captioned video needs. `model`: the clip model of new videos. */
export type StudioCapabilities = { composition: boolean; subtitles?: boolean; knowledge: boolean; narration?: boolean; model?: MarketingVideoProfile };

/** Why the twin narration of a planned board stops generation, if it does. Takes are needed only
 * before the clips are paid for, so a missing board or plan never blocks here. */
export function narrationBlocker(draft: MarketingDraft, capabilities: StudioCapabilities | null, planError: string,
  clips: MarketingNarrationClip[] | null): string {
  if (!marketingVoiceover(draft)) return "";
  if (!capabilities?.narration) return "数字分身配音服务未启用，请改用 AI 配音。";
  if (!draft.narration?.twinItemId) return "请先选择数字分身旁白音色。";
  if (!draft.storyboard.length || planError) return "";
  if (!clips?.every(clip => clip.status === "succeeded")) return "请先生成全部分镜的数字分身配音并试听。";
  const tooLong = clips.some((clip, i) => !marketingNarrationFits(clip.durationMs ?? 0, draft.storyboard[i]?.durationSec ?? 15));
  return tooLong ? "有分镜的配音长于镜头时长，请按配音调整分镜时长。" : "";
}

/** Whether a selected material is gone or no longer accepted for new videos. */
export const unusableMaterial = (draft: MarketingDraft, materials: Record<string, Material>) =>
  Object.entries(draft.assets).some(([slot, value]) => marketingAssetIds(value).some(id => {
    const item = materialFor(materials, slot, id);
    return !item || item.issue;
  }));

/** Why the open draft cannot be generated now, if anything; checked in this order. */
export function generationBlocker(state: {
  ready: boolean; loadError: string; draft: MarketingDraft; profile: MarketingVideoProfile; capabilities: StudioCapabilities | null;
  materials: Record<string, Material>; planError: string; narration: MarketingNarrationClip[] | null;
}): string {
  const { draft, capabilities } = state;
  if (!state.ready) return state.loadError || "正在加载草稿…";
  if (unusableMaterial(draft, state.materials)) return "素材已不可用或不支持新生成，请移除或替换。";
  return marketingReferenceError(draft, state.profile) || state.planError
    || (!capabilities?.composition ? "视频合成工具不可用，请配置 FFmpeg 和 FFprobe。" : "")
    || (draft.subtitles && !capabilities?.subtitles ? "当前环境不支持字幕，可关闭字幕后生成。" : "")
    || narrationBlocker(draft, capabilities, state.planError, state.narration);
}

/** Confirmation needed when the board was planned for the other reference video setting. */
export function audioMismatchConfirmation(draft: MarketingDraft): ConfirmRequest | undefined {
  if (!marketingStoryboardAudioMismatch(draft)) return undefined;
  return { title: "分镜与参考视频设置不一致", confirm: "仍然生成", message: draft.assets.video
    ? "已添加参考视频，成片不生成口播，但当前分镜按有声口播编写。建议先重新生成分镜。仍要按当前分镜生成吗？"
    : "已移除参考视频，成片会生成口播，但当前分镜按无声展示编写。建议先重新生成分镜。仍要按当前分镜生成吗？" };
}

/** Confirmation needed when the shots have no key-art still. Without any reference image either,
 * nothing but text ties the shots together, and a redone shot is billed as video. */
export function missingKeyArtConfirmation(draft: MarketingDraft): ConfirmRequest {
  return { title: "未使用定妆图", confirm: "仍然生成", message: marketingImageCount(draft.assets)
    ? "没有定妆图时，各镜头只靠文字描述保持人物、服装和场景一致，容易出现不一致。建议先在「确认分镜」下生成定妆图。仍要直接生成视频吗？"
    : "没有定妆图，也没有上传肖像、产品或空间参考图，各镜头只靠文字描述，人物、产品和场景可能每镜都不一样。成片后重新生成单镜画面仍按视频模型计费。建议先在「确认分镜」下生成定妆图。确定直接生成视频吗？" };
}
