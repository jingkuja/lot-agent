import { api, absoluteMedia, type GenerationResult } from "./api";

export const VIDEO_MODELS = [
  { label: "旗舰", id: "doubao-seedance-2-5", description: "旗舰创作", resolution: "1080p" },
  { label: "质量", id: "doubao-seedance-2-0", description: "精细画面", resolution: "720p" },
  { label: "快速", id: "minimax-video-h3", description: "快速出片", resolution: "480p" },
];
export const VIDEO_STEPS = ["文案创作", "标题标签", "声音设置", "视频画面", "BGM·字幕", "视频封面", "生成与分享"];
export const LAST_VIDEO_STEP = VIDEO_STEPS.length - 1;
export const VIDEO_VOICES = ["自然旁白", "温柔女声", "沉稳男声", "活力讲述", "无配音"];
export const VIDEO_MUSIC = ["无配乐", "轻快", "舒缓", "电影感", "动感"];
export const VIDEO_RATIOS = ["9:16", "16:9", "1:1"];
export const VIDEO_DURATIONS = [5, 10];
/** The server finishes a submission it received even after the client disconnects, so a
 * conversation still without a generation message this long after submit was never submitted. */
export const VIDEO_SUBMIT_GRACE_MS = 3 * 60_000;
/** After this long the user may stop waiting on this page; the task itself keeps running. */
export const VIDEO_TASK_STALE_MS = 30 * 60_000;

export function createVideoDraft() {
  return { topic: "", script: "", mainTitle: "", subtitle: "", publishTitle: "", tags: "", voice: VIDEO_VOICES[0], bgm: VIDEO_MUSIC[0], subtitles: true, modelIndex: 0, ratio: VIDEO_RATIOS[0], durationSec: VIDEO_DURATIONS[0], reference: "", cover: "" };
}
export type VideoDraft = ReturnType<typeof createVideoDraft>;

/** Rebuild a draft from untrusted storage: unknown keys, wrong types and retired options fall back to defaults. */
export function restoreVideoDraft(stored: unknown): VideoDraft {
  const draft = createVideoDraft();
  if (!stored || typeof stored !== "object") return draft;
  const source = stored as Record<string, unknown>;
  for (const name of Object.keys(draft) as Array<keyof VideoDraft>) {
    if (typeof source[name] === typeof draft[name]) (draft as Record<string, unknown>)[name] = source[name];
  }
  if (!VIDEO_MODELS[draft.modelIndex]) draft.modelIndex = 0;
  if (!VIDEO_RATIOS.includes(draft.ratio)) draft.ratio = VIDEO_RATIOS[0];
  if (!VIDEO_DURATIONS.includes(draft.durationSec)) draft.durationSec = VIDEO_DURATIONS[0];
  if (!VIDEO_VOICES.includes(draft.voice)) draft.voice = VIDEO_VOICES[0];
  if (!VIDEO_MUSIC.includes(draft.bgm)) draft.bgm = VIDEO_MUSIC[0];
  return draft;
}

export function videoSettings(draft: VideoDraft) {
  return { resolution: VIDEO_MODELS[draft.modelIndex].resolution, ratio: draft.ratio, durationSec: draft.durationSec, generate_audio: draft.voice !== "无配音" || draft.bgm !== "无配乐" };
}
export function buildVideoPrompt(draft: VideoDraft): string {
  const mainTitle = draft.mainTitle.trim();
  const subtitle = draft.subtitle.trim();
  return [
    "创作一条短视频，按以下创作要求完成：", `视频文案与分镜：${draft.script.trim()}`,
    `声音：${draft.voice}。${draft.voice === "无配音" ? "不要旁白。" : "用中文自然讲述文案，控制在视频时长内。"}`,
    `背景音乐：${draft.bgm}。`, draft.subtitles ? "添加与旁白一致的简体中文字幕，保持清晰易读。" : "不要添加字幕。",
    // An empty title line would ask the model to render literal blanks; the cover step says titles are optional.
    mainTitle || subtitle ? `开场封面主标题：${mainTitle}${subtitle ? `；副标题：${subtitle}` : ""}。` : "",
    "保持主体一致，画面连贯，不添加水印。",
  ].filter(Boolean).join("\n");
}

/** Only inputs sent to the video model participate; publishing copy is free to edit. */
export function videoSignature(draft: VideoDraft): string {
  return JSON.stringify([VIDEO_MODELS[draft.modelIndex].id, buildVideoPrompt(draft), videoSettings(draft), draft.cover || draft.reference]);
}

export function isDefinitiveVideoRejection(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return !!status && status < 500 && status !== 408 && status !== 409;
}

/** Page-facing text for a failed request. Server rejections are English/internal, so only
 * Chinese (already user-facing) messages pass through; quota exhaustion gets a specific hint. */
export function videoErrorText(error: unknown, fallback: string): string {
  if ((error as { status?: number } | null)?.status === 402) return "账户积分不足，请充值后再试";
  const message = error instanceof Error ? error.message : "";
  return /[\u4e00-\u9fff]/.test(message) ? message : fallback;
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
  try {
    onConversation(conv.id);
  } catch (error) {
    // No paid request has been sent when the page is gone or persistence fails.
    await api.deleteConversation(conv.id).catch(() => {});
    throw error;
  }
  let started: GenerationResult;
  try {
    started = await api.generate(conv.id, {
      prompt: buildVideoPrompt(draft), mediaType: "video",
      model: VIDEO_MODELS[draft.modelIndex].id, settings: videoSettings(draft), first_frame: firstFrame,
    });
  } catch (error) {
    if (isDefinitiveVideoRejection(error)) {
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

/** The persisted generation message of a video conversation — the durable record of a paid
 * attempt, readable even when the submit response was lost. */
export interface VideoGeneration {
  messageId: string;
  taskId: string;
  status: string;
  url: string;
  downloadFailed: boolean;
}

/** Returns null when the conversation has no video generation message (or no longer exists):
 * nothing was persisted, so nothing was billed. */
export async function findVideoGeneration(conversationId: string): Promise<VideoGeneration | null> {
  let conv: Awaited<ReturnType<typeof api.getConversation>>;
  try {
    conv = await api.getConversation(conversationId);
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 404) return null;
    throw error;
  }
  for (const message of [...conv.messages].reverse()) {
    let meta = message.metadata;
    try { if (typeof meta === "string") meta = JSON.parse(meta); } catch { continue; }
    const value = meta as { kind?: string; mediaType?: string; taskId?: string; status?: string; assets?: Array<{ url?: string }> } | undefined;
    if (message.role !== "assistant" || value?.kind !== "generation" || value.mediaType !== "video") continue;
    const status = typeof value.status === "string" ? value.status : ((message as { status?: string }).status ?? "generating");
    return {
      messageId: message.id,
      taskId: typeof value.taskId === "string" ? value.taskId : "",
      status,
      url: status === "completed" ? absoluteMedia(value.assets?.[0]?.url) : "",
      downloadFailed: status === "download_failed",
    };
  }
  return null;
}
export async function recoverVideoTask(conversationId: string): Promise<string | null> {
  return (await findVideoGeneration(conversationId))?.taskId || null;
}
export function videoResult(task: Awaited<ReturnType<typeof api.getTask>>): string {
  return task.status === "succeeded" && !task.output?.downloadFailed ? absoluteMedia(task.output?.assets?.[0]?.url) : "";
}
