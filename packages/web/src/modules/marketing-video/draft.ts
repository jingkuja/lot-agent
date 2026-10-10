import type { PickedFile } from "../../api/client.js";
import type { VideoSettings } from "../../components/MediaSettings.js";
import { pickVideoQuality, KLING_VIDEO_QUALITIES } from "../../lib/video-settings.js";

export const MARKETING_VIDEO_MODEL = "kling-video-v3-omni";
export const MARKETING_VIDEO_QUALITIES = KLING_VIDEO_QUALITIES.map((quality, index) => ({
  ...quality, label: ["默认", "高清", "超清"][index],
}));

export const STEPS = ["创作方向与文案", "标题标签", "数字分身", "声音设置", "视频背景", "视频画面", "BGM·字幕", "视频封面", "确认生成"];
export const DIRECTIONS = ["探店店铺介绍", "主播宣传演讲"];
export const BACKGROUNDS = ["真实店铺", "温馨生活场景", "简约演播室", "品牌展示空间", "自定义背景"];
export const VOICES = ["自然旁白", "温柔女声", "沉稳男声", "活力讲述", "无配音"];
export const MUSIC = ["无配乐", "轻快", "舒缓", "电影感", "动感"];
export type Translate = (source: string, values?: readonly unknown[]) => string;

export function createDraft() {
  return {
    direction: DIRECTIONS[0], topic: "", script: "", mainTitle: "", subtitle: "", publishTitle: "", tags: "",
    voice: VOICES[0], bgm: MUSIC[0], subtitles: true, background: BACKGROUNDS[0], backgroundDetail: "",
    ratio: "9:16", durationSec: 5, quality: "720p",
  };
}
export type Draft = ReturnType<typeof createDraft>;
export interface DraftFiles { portrait?: File; voice?: File; background?: File; cover?: File; }

export function buildSubmission(draft: Draft, assets: DraftFiles, t: Translate): { prompt: string; files: PickedFile[]; settings: VideoSettings } {
  const files: PickedFile[] = [];
  const imageReference = (file: File) => {
    files.push({ file, slot: "video_reference_image" });
    const index = files.filter((item) => item.slot === "video_reference_image").length;
    return t("图片{0}", [index]);
  };
  const portrait = assets.portrait ? imageReference(assets.portrait) : "";
  const background = assets.background ? imageReference(assets.background) : "";
  if (assets.voice) files.push({ file: assets.voice, slot: "video_reference_audio" });
  if (assets.cover) files.push({ file: assets.cover, slot: "video_first_frame" });
  const quality = pickVideoQuality(MARKETING_VIDEO_QUALITIES, draft.quality);
  const [rw, rh] = draft.ratio.split(":").map(Number);
  const long = Math.round(quality.edge * Math.max(rw, rh) / Math.min(rw, rh) / 8) * 8;
  const settings = {
    size: rw >= rh ? `${long}x${quality.edge}` : `${quality.edge}x${long}`,
    durationSec: draft.durationSec, ratio: draft.ratio, quality: quality.short,
    generate_audio: !!assets.voice || draft.voice !== "无配音" || draft.bgm !== "无配乐",
  };
  const prompt = [
    t("创作方向：{0}。", [t(draft.direction)]),
    t(draft.direction === DIRECTIONS[0]
      ? "以店铺实景、特色产品和服务细节为主线，穿插自然的探店介绍，以到店邀请收尾。"
      : "以主播面对镜头的自然口播为主线，突出核心卖点和演讲节奏，以行动邀请收尾。"),
    t("视频文案与分镜：{0}", [draft.script.trim()]),
    t("只使用文案中已提供的事实，不虚构地址、价格、优惠或背书。旁白语言与文案一致，并控制在 {0} 秒内。", [draft.durationSec]),
    portrait ? t("视频主角的外貌参考 {0}，保持人物形象一致。", [portrait]) : t("未指定数字分身，根据文案安排人物或产品镜头。"),
    t("视频背景：{0}。{1}", [t(draft.background), draft.backgroundDetail.trim()]),
    background ? t("场景和空间布局参考 {0}，不要把背景图中的人物当作主角。", [background]) : "",
    t("旁白风格：{0}。", [t(draft.voice)]),
    assets.voice ? t("全片人声参考 {0} 的音色，按照以下文案配音。", [t("音频{0}", [1])]) : "",
    t("背景音乐：{0}。", [t(draft.bgm)]),
    t(draft.subtitles ? "添加与旁白语言和内容一致的清晰字幕。" : "不要添加字幕。"),
    draft.mainTitle.trim() ? t("开场封面主标题：{0}", [draft.mainTitle.trim()]) : "",
    draft.subtitle.trim() ? t("开场封面副标题：{0}", [draft.subtitle.trim()]) : "",
    assets.cover ? t("使用上传的封面图作为首帧，随后自然过渡到主体场景。") : "",
    t("保持主体一致，画面连贯，不添加水印。"),
  ].filter(Boolean).join("\n");
  return { prompt, files, settings };
}
