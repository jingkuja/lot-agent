import type {
  ComicAutoDialoguePlan, ComicAutoDialogueResult, ComicEdit, ComicEditAppendSource, ComicEditAutoDialogue, ComicEditAutoDialoguePreview,
  ComicEditCreate, ComicEditList, ComicEditReplace, ComicEditUpdate, ComicRender, ComicRenderDownload, ComicRenderHistory, ComicRenderRequest,
  ComicSpeechLines, ComicSpeechRelease, ComicSpeechRequest, ComicSpeechTake, ComicVoiceAudition, ComicVoiceAuditionRelease,
  ComicVoiceBind, ComicVoiceSettings,
} from "@lot-agent/core/comic-drama";
import { ApiClientError, request } from "../../api/client.js";
import { libraryError } from "./LibraryParts.js";

const root = "/comic-drama";
const edit = (id: string) => root + "/edits/" + encodeURIComponent(id);
const item = (id: string, itemId: string) => edit(id) + "/items/" + encodeURIComponent(itemId);
const voice = (id: string) => root + "/characters/" + encodeURIComponent(id) + "/voice";
const send = <T>(url: string, method: string, value: unknown, signal?: AbortSignal) =>
  request<T>(url, { method, body: JSON.stringify(value), signal });
export const comicEditApi = {
  list: (cursor?: string, signal?: AbortSignal) => request<ComicEditList>(root + "/edits" + (cursor ? "?" + new URLSearchParams({ cursor }) : ""), { signal }),
  get: (id: string, signal?: AbortSignal) => request<ComicEdit>(edit(id), { signal }),
  create: (fields: ComicEditCreate, signal?: AbortSignal) => send<ComicEdit>(root + "/edits", "POST", fields, signal),
  update: (id: string, fields: ComicEditUpdate) => send<ComicEdit>(edit(id), "PATCH", fields),
  remove: (id: string, expectedRevision: number) => send<{ ok: true }>(edit(id), "DELETE", { expectedRevision }),
  replace: (id: string, itemId: string, fields: ComicEditReplace, signal?: AbortSignal) =>
    send<ComicEdit>(item(id, itemId) + "/replace", "POST", fields, signal),
  appendSource: (id: string, fields: ComicEditAppendSource, signal?: AbortSignal) =>
    send<ComicEdit>(edit(id) + "/append-source", "POST", fields, signal),
  previewAutoDialogue: (id: string, fields: ComicEditAutoDialoguePreview, signal?: AbortSignal) =>
    send<ComicAutoDialoguePlan>(edit(id) + "/auto-dialogue/preview", "POST", fields, signal),
  autoDialogue: (id: string, fields: ComicEditAutoDialogue, signal?: AbortSignal) =>
    send<ComicAutoDialogueResult>(edit(id) + "/auto-dialogue", "POST", fields, signal),
  lines: (id: string, itemId: string, signal?: AbortSignal) => request<ComicSpeechLines>(item(id, itemId) + "/lines", { signal }),
  speak: (id: string, itemId: string, line: string, fields: ComicSpeechRequest, signal?: AbortSignal) =>
    send<ComicSpeechTake>(item(id, itemId) + "/lines/" + encodeURIComponent(line) + "/speech", "POST", fields, signal),
  releaseSpeech: (id: string, itemId: string, line: string, fields: ComicSpeechRelease, signal?: AbortSignal) =>
    send<{ ok: true }>(item(id, itemId) + "/lines/" + encodeURIComponent(line) + "/speech/release", "POST", fields, signal),
  voice: (id: string, signal?: AbortSignal) => request<ComicVoiceSettings>(voice(id), { signal }),
  bindVoice: (id: string, fields: ComicVoiceBind, signal?: AbortSignal) => send<{ ok: true }>(voice(id), "PUT", fields, signal),
  auditionVoice: (fields: ComicVoiceAudition, signal?: AbortSignal) => send<ComicSpeechTake>(root + "/voices/audition", "POST", fields, signal),
  releaseAuditionVoice: (fields: ComicVoiceAuditionRelease, signal?: AbortSignal) =>
    send<{ ok: true }>(root + "/voices/audition/release", "POST", fields, signal),
  startRender: (id: string, fields: ComicRenderRequest) => send<ComicRender>(edit(id) + "/render", "POST", fields),
  render: (id: string, signal?: AbortSignal) => request<ComicRender>(root + "/renders/" + encodeURIComponent(id), { signal }),
  renders: (editId?: string, cursor?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (editId) params.set("editId", editId);
    if (cursor) params.set("cursor", cursor);
    return request<ComicRenderHistory>(root + "/renders?" + params, { signal });
  },
  renderControl: (id: string, action: "recover" | "cancel") => send<ComicRender>(root + "/renders/" + encodeURIComponent(id) + "/" + action, "POST", {}),
  downloadRender: (id: string, inline = false) =>
    request<ComicRenderDownload>(root + "/renders/" + encodeURIComponent(id) + "/download" + (inline ? "?inline=1" : "")),
  removeRender: (id: string) => request<{ ok: true }>(root + "/renders/" + encodeURIComponent(id), { method: "DELETE" }),
};
const errors: Record<string, string> = {
  COMIC_SUBMISSIONS_PAUSED: "新生成和导出已暂停",
  REVISION_CONFLICT: "其他窗口已保存工程，本地修改仍在本页",
  INVALID_TIMELINE: "请检查时间线中的裁切和素材",
  EDIT_ADOPTION_CHANGED: "采用版本已更换，请重新读取工程",
  EDIT_SOURCE_UNAVAILABLE: "片源不可用，请重新选择",
  EDIT_SOURCE_DURATION_CHANGED: "片源时长已变化，请重新选择",
  EDIT_TRIM_REQUIRED: "请先调整裁切范围",
  EDIT_ATTACHED_OVERFLOW: "配音或其他依附内容超出裁切范围",
  INVALID_AUDIO_TRIM: "音频裁切超出了源文件范围",
  EDIT_VOICE_UNAVAILABLE: "此音色未就绪或需重新授权",
  EDIT_DIALOGUE_CHANGED: "分镜台词已变化，请重新读取",
  EDIT_SPEECH_RUNNING: "这句配音正在合成",
  EDIT_SPEECH_UNAVAILABLE: "语音服务暂不可用，请检查模型账号",
  EDIT_LOCAL_SPEECH_FAILED: "本机配音失败，请检查 macOS 系统语音和 FFmpeg",
  EDIT_SPEECH_UNKNOWN: "配音结果待核实，原请求可能已计费",
  EDIT_SPEECH_NOT_RELEASABLE: "此句配音暂不可释放，请重新读取台词",
  EDIT_SPEECH_SUPERSEDED: "旧的配音请求已失效，请以最新提交结果为准",
  INVALID_MATERIAL_REFERENCE: "所选场景、道具或音效素材不可用，请重新选择",
  CONTENT_COMPLIANCE_REJECTED: "内容未通过安全合规检查，请修改剧本、分镜或台词后重试",
  RENDER_NO_VIDEO: "请先添加视频片段",
  RENDER_LIMIT: "导出最多支持 5 分钟、60 段视频及 240 条音频",
  RENDER_TRACK_OVERFLOW: "有配音、音乐、音效或字幕超出可用时间，请调整后导出",
  RENDER_FRAME_RANGE: "裁切或转场不足一帧，请调整时间",
  RENDER_QUEUE_UNAVAILABLE: "导出队列暂不可用",
  RENDER_SOURCE_UNAVAILABLE: "导出源文件不可用",
  RENDER_SOURCE_CHANGED: "导出源文件时长有变化",
  RENDER_FFMPEG_UNAVAILABLE: "导出工具缺少视频、转场或字幕支持",
  RENDER_DISK_SPACE_LOW: "导出临时磁盘空间不足，请稍后重试或清理磁盘空间",
  RENDER_FAILED: "合成失败，请检查素材后重新导出",
  RENDER_CANCEL_UNAVAILABLE: "该导出已结束，无法取消",
  RENDER_CONTROL_BUSY: "导出状态正在更新，请稍后重试",
  RENDER_RECOVERY_UNAVAILABLE: "队列仍在处理原任务或暂不可用，请稍后重试",
  RENDER_DOWNLOAD_UNAVAILABLE: "合成完成后即可下载",
  RENDER_DELETE_UNAVAILABLE: "导出完成后即可删除",
};
export const comicRenderError = (code: string) => errors[code] ?? errors.RENDER_FAILED;
export function editError(error: unknown) {
  return error instanceof ApiClientError && error.code ? errors[error.code] ?? libraryError(error) : libraryError(error);
}
