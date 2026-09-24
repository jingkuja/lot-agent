import { api, absoluteMedia, type GenerationResult } from "./api";

export const VIDEO_MODELS = [
  { label: "旗舰", id: "doubao-seedance-2-5", description: "旗舰创作", resolution: "1080p" },
  { label: "质量", id: "doubao-seedance-2-0", description: "精细画面", resolution: "720p" },
  { label: "快速", id: "minimax-video-h3", description: "快速出片", resolution: "480p" },
];
export const VIDEO_STEPS = ["文案创作", "标题标签", "声音设置", "视频画面", "BGM·字幕", "视频封面", "发布分享"];
export function createVideoDraft() {
  return { topic: "", script: "", mainTitle: "", subtitle: "", publishTitle: "", tags: "", voice: "自然旁白", bgm: "无配乐", subtitles: true, modelIndex: 0, ratio: "9:16", durationSec: 5, reference: "", cover: "" };
}
export type VideoDraft = ReturnType<typeof createVideoDraft>;
export function videoSettings(draft: VideoDraft) {
  return { resolution: VIDEO_MODELS[draft.modelIndex].resolution, ratio: draft.ratio, durationSec: draft.durationSec, generate_audio: draft.voice !== "无配音" || draft.bgm !== "无配乐" };
}
export function buildVideoPrompt(draft: VideoDraft): string {
  return [
    "创作一条短视频，按以下创作要求完成：", `视频文案与分镜：${draft.script.trim()}`,
    `声音：${draft.voice}。${draft.voice === "无配音" ? "不要旁白。" : "用中文自然讲述文案，控制在视频时长内。"}`,
    `背景音乐：${draft.bgm}。`, draft.subtitles ? "添加与旁白一致的简体中文字幕，保持清晰易读。" : "不要添加字幕。",
    `开场封面主标题：${draft.mainTitle}；副标题：${draft.subtitle}。`, "保持主体一致，画面连贯，不添加水印。",
  ].join("\n");
}

/** Submission and polling are separate so hiding the page never loses a queued task. */
export async function submitVideo(draft: VideoDraft, onConversation: (id: string) => void): Promise<{ conversationId: string; taskId: string }> {
  const conv = await api.createConversation(draft.publishTitle || draft.mainTitle || draft.topic.slice(0, 24) || "视频创作", "video");
  let firstFrame: string | undefined;
  try {
    const ref = draft.cover || draft.reference;
    if (ref) firstFrame = (await api.uploadLocalImage(ref)).url;
  } catch (error) {
    await api.deleteConversation(conv.id).catch(() => {});
    throw error;
  }
  onConversation(conv.id);
  let started: GenerationResult;
  try {
    started = await api.generate(conv.id, {
      prompt: buildVideoPrompt(draft), mediaType: "video",
      model: VIDEO_MODELS[draft.modelIndex].id, settings: videoSettings(draft), first_frame: firstFrame,
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status && status < 500 && status !== 408) {
      await api.deleteConversation(conv.id).catch(() => {});
      throw error;
    }
    // Never retry a paid submission after a lost response. Recover only from its own conversation.
    const task = await recoverVideoTask(conv.id).catch(() => null);
    if (!task) throw new Error("提交结果待确认，请点「查询进度」，勿重复生成");
    return { conversationId: conv.id, taskId: task };
  }
  return { conversationId: conv.id, taskId: started.taskId };
}
export async function recoverVideoTask(conversationId: string): Promise<string | null> {
  const conv = await api.getConversation(conversationId);
  for (const message of [...conv.messages].reverse()) {
    let meta = message.metadata;
    try { if (typeof meta === "string") meta = JSON.parse(meta); } catch { continue; }
    const value = meta as { kind?: string; mediaType?: string; taskId?: string } | undefined;
    if (message.role === "assistant" && value?.kind === "generation" && value.mediaType === "video" && value.taskId) return value.taskId;
  }
  return null;
}
export function videoResult(task: Awaited<ReturnType<typeof api.getTask>>): string {
  return task.status === "succeeded" && !task.output?.downloadFailed ? absoluteMedia(task.output?.assets?.[0]?.url) : "";
}
