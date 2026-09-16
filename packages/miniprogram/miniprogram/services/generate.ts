import { api, absoluteMedia, type GenerationResult } from "./api";
import { imageModelForQuality } from "./config";
import {
  getStudioConversationId,
  setStudioConversationId,
} from "./session";

export interface GenerateInput {
  prompt: string;
  size: string;
  quality: string;
  localRefs?: string[];
  title?: string;
  reuseStudioConversation?: boolean;
  /** 状态文案 + 进度百分比(0-100)。进度由本地模拟器合成,95% 封顶等待真实任务 */
  onStatus?: (text: string, progress?: number) => void;
  /** 拿到 conversationId + taskId 后立即回调,让外部能跟踪这次生成 */
  onTask?: (info: { conversationId: string; taskId: string; title?: string }) => void;
}

export interface GenerateOutput {
  conversationId: string;
  messageId: string;
  taskId: string;
  imageUrl: string;
  title?: string;
}

async function ensureConversation(title?: string, reuse = false): Promise<string> {
  if (reuse) {
    const existing = getStudioConversationId();
    if (existing) return existing;
  }
  const conv = await api.createConversation(title);
  if (reuse) setStudioConversationId(conv.id);
  return conv.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 本地进度模拟器:约 57s 走到 95%,95% 之后停住等真实任务完成。
 * 每个 tick 重新按 elapsed 计算,不需要额外定时器。
 */
const SIM_FULL_MS = 57000;
const SIM_CAP = 95;

function simulatedProgress(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  if (elapsed <= 0) return 0;
  const ratio = elapsed / SIM_FULL_MS;
  if (ratio >= 1) return SIM_CAP;
  // 缓出曲线:前面快,接近 95% 时减速,让用户感觉"快好了"
  const eased = 1 - Math.pow(1 - ratio, 1.6);
  return Math.min(SIM_CAP, Math.round(eased * SIM_CAP));
}

/** 服务端 4xx/5xx 或网络错误的统一提示,不透出后端细节 */
const GENERIC_ERROR = "服务暂时不可用,请稍后再试,也可查看剩余积分是否充足";

/** 把内部错误收敛成对外文案;已知用户友好的文案(超时/取消)原样保留 */
function toPublicError(err: unknown): Error {
  if (err instanceof Error) {
    // 这几种是面向用户的明确提示,不要替换成通用文案
    const keep = ["生成超时", "已取消"];
    if (keep.some((k) => err.message.includes(k))) return err;
  }
  return new Error(GENERIC_ERROR);
}

async function pollTask(
  taskId: string,
  onStatus?: GenerateInput["onStatus"],
  startedAt: number = Date.now()
): Promise<{ url: string }> {
  let failures = 0;
  const deadline = Date.now() + 3 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("生成超时,请稍后在「作品」里查看");
    let task;
    try {
      task = await api.getTask(taskId);
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= 8) {
        throw toPublicError(err);
      }
      onStatus?.("AI 正在画,请稍等", simulatedProgress(startedAt));
      await sleep(1500);
      continue;
    }
    if (task.status === "pending" || task.status === "running") {
      onStatus?.("AI 正在画,请稍等", simulatedProgress(startedAt));
      await sleep(1200);
      continue;
    }
    if (task.status === "cancelled") throw new Error("已取消");
    if (task.status === "failed") throw new Error(GENERIC_ERROR);
    if (task.status === "succeeded") {
      if (task.output?.downloadFailed) throw new Error(GENERIC_ERROR);
      const url = task.output?.assets?.[0]?.url;
      if (!url) throw new Error(GENERIC_ERROR);
      onStatus?.("做好啦", 100);
      return { url: absoluteMedia(url) };
    }
    throw new Error(GENERIC_ERROR);
  }
}

export async function runImageGeneration(input: GenerateInput): Promise<GenerateOutput> {
  const startedAt = Date.now();
  const conversationId = await ensureConversation(input.title, input.reuseStudioConversation);
  const media: Array<{ type: "reference_image"; url: string }> = [];
  try {
    if (input.localRefs?.length) {
      onUpload(input);
      for (const path of input.localRefs) {
        if (/^https?:\/\//i.test(path) || path.startsWith("/static/")) {
          media.push({ type: "reference_image", url: path });
          continue;
        }
        const uploaded = await api.uploadLocalImage(path);
        media.push({ type: "reference_image", url: uploaded.url });
      }
    }
  } catch {
    // 上传失败也清理刚建的空会话
    try {
      await api.deleteConversation(conversationId);
    } catch {
      /* ignore */
    }
    throw new Error(GENERIC_ERROR);
  }
  input.onStatus?.("正在提交", 0);
  let started: GenerationResult;
  try {
    started = await api.generate(conversationId, {
      prompt: input.prompt,
      mediaType: "image",
      settings: { size: input.size, quality: input.quality, n: 1 },
      media: media.length ? media : undefined,
      model: imageModelForQuality(input.quality),
    });
  } catch (err) {
    // 提交失败(401/400/402/5xx 等):清理刚创建的会话,让作品区不出现空壳条目;
    // 错误信息统一收敛,不透出后端细节。
    try {
      await api.deleteConversation(conversationId);
    } catch {
      // 删除失败也无所谓 —— 服务端那条只是空会话,会被 listConversations 的"必须有 message"过滤掉
    }
    throw toPublicError(err);
  }
  input.onStatus?.("AI 正在画,请稍等", simulatedProgress(startedAt));
  input.onTask?.({
    conversationId,
    taskId: started.taskId,
    title: started.title,
  });
  let url: string;
  try {
    ({ url } = await pollTask(started.taskId, input.onStatus, startedAt));
  } catch (err) {
    // 任务进行中被后台标 failed 时,服务端那条会话里其实有失败消息记录,保留供"作品"页排查;
    // 但错误文案仍然要统一。
    throw toPublicError(err);
  }
  return {
    conversationId,
    messageId: started.assistantMessage.id,
    taskId: started.taskId,
    imageUrl: url,
    title: started.title,
  };
}

function onUpload(input: GenerateInput) {
  input.onStatus?.("正在上传图片");
}

export function toastError(err: unknown): void {
  const message = err instanceof Error ? err.message : "出了一点问题";
  wx.showToast({ title: message.slice(0, 20), icon: "none" });
}
