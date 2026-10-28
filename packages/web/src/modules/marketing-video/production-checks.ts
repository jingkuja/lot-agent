import { marketingAssetIds, marketingImageCount, marketingNarrationFits, marketingReferenceError, marketingStoryboardAudioMismatch, marketingVoiceover,
  type MarketingDraft, type MarketingNarrationClip, type MarketingReview, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
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
  /** A key-art still of the current look exists; the clips will carry it as a reference image. */
  keyArt?: boolean;
}): string {
  const { draft, capabilities } = state;
  if (!state.ready) return state.loadError || "正在加载草稿…";
  if (unusableMaterial(draft, state.materials)) return "素材已不可用或不支持新生成，请移除或替换。";
  return marketingReferenceError(draft, state.profile, state.keyArt) || state.planError
    || (!capabilities?.composition ? "视频合成工具不可用，请配置 FFmpeg 和 FFprobe。" : "")
    || (draft.subtitles && !capabilities?.subtitles ? "当前环境不支持字幕，可关闭字幕后生成。" : "")
    || narrationBlocker(draft, capabilities, state.planError, state.narration);
}

/** The creation step where the board is confirmed and the video generated. */
export const CONFIRM_STEP = 3;

/** One line of the list above the generate button; `values` fill its `{0}` placeholders. ok: done; auto: done while generating;
 * info: worth knowing; warn: worth a look, and with `confirm` the user accepts it once before generating; block: to be fixed first. */
export type GenerationCheck = { text: string; values?: number[]; state: "ok" | "auto" | "info" | "warn" | "block"; confirm?: boolean };

/** What generating the draft does, risks and costs, in that order. `keyArt`: whether a still of the current look exists,
 * undefined when this video takes none or it is not known yet. `keyArtRunning`: another still of it is being made.
 * `review`: verdict of a check of the current text; the user is asked before generating unchecked or rejected text. */
export function generationChecks(draft: MarketingDraft, { keyArt, keyArtRunning, review }: {
  keyArt?: boolean; keyArtRunning?: boolean; review?: MarketingReview["verdict"];
}): GenerationCheck[] {
  const checks: GenerationCheck[] = [];
  if (marketingStoryboardAudioMismatch(draft)) checks.push({ state: "warn", confirm: true, text: draft.assets.video
    ? "已添加动作参考视频，但分镜按有声口播编写。建议先重新生成分镜。" : "已移除动作参考视频，但分镜按无声展示编写。建议先重新生成分镜。" });
  // Without the still, shots keep the same person and setting only through the text.
  if (keyArt !== undefined && keyArtRunning) checks.push({ state: "warn", confirm: true, text: keyArt
    ? "新的定妆图还在生成，现在生成视频将使用上一张定妆图。" : "定妆图还在生成，现在生成视频将不使用定妆图。" });
  else if (keyArt === true) checks.push({ state: "ok", text: "已生成定妆图，各镜头共用这张参考图。" });
  else if (keyArt === false) checks.push({ state: "warn", confirm: true, text: marketingImageCount(draft.assets)
    ? "未生成定妆图，各镜头只靠文字保持人物和场景一致。" : "未生成定妆图，也没有参考图，各镜头的人物、产品和场景可能不同。" });
  checks.push(review === "pass" ? { state: "ok", text: "文案检查已通过。" }
    : review === "suspect" ? { state: "warn", text: "文案检查有内容需要核实，发布前请核实。" }
    : review === "reject" ? { state: "warn", text: "文案检查未通过，建议修改后再生成。" }
    : { state: "info", text: "尚未检查文案，生成前会询问是否先检查。" });
  if (!draft.publishTitle.trim() || !draft.tags.trim()) checks.push({ state: "auto", text: "提交后自动补全标题和标签，并再次检查。" });
  // The rate only: the total varies by model and shot, and storyboard reruns cost too.
  checks.push({ state: "info", text: "成片每秒约消耗 120–150 积分，重新生成分镜也会消耗积分。" });
  return checks;
}

/** One confirmation for every check the user has to accept; undefined when there is none. */
export function generationConfirmation(checks: GenerationCheck[], t: (source: string) => string): ConfirmRequest | undefined {
  const accepted = checks.filter(check => check.confirm);
  if (!accepted.length) return undefined;
  // Each line is translated here; the dialog shows the joined text as it is.
  return { title: "确认生成视频？", confirm: "仍然生成", message: [...accepted.map(check => t(check.text)), t("仍要生成视频吗？")].join("\n") };
}

/** Asks whether to check the copy first when it is unchecked or was rejected; undefined when it passed or only needs verifying. */
export function reviewQuestion(review: MarketingReview["verdict"] | undefined): ConfirmRequest | undefined {
  if (review === "pass" || review === "suspect") return undefined;
  return review === "reject"
    ? { title: "文案检查未通过", message: "文案检查发现需要修改的内容。是否继续处理文案检查？选择「直接生成」将不再检查，直接生成视频。",
      confirm: "继续检查", alternative: "直接生成" }
    : { title: "尚未检查文案", message: "是否先检查文案再生成视频？选择「直接生成」将跳过检查，直接生成视频。", confirm: "检查文案", alternative: "直接生成" };
}
