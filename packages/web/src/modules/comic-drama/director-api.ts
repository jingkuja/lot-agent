import {
  COMIC_SCRIPT_DOCX, type ComicClipCheckIssue, type ComicDirectorChatInput, type ComicDirectorChatResponse, type ComicDirectorDecision,
  type ComicDirectorInput, type ComicDirectorProposal, type ComicDirectorRoleDecision, type ComicDirectorRoleOutcome, type ComicDirectorState,
  type ComicGenerationPreviewRequest, type ComicGenerationQuote, type ComicScriptImport,
} from "@lot-agent/core/comic-drama";
import { ApiClientError, request } from "../../api/client.js";
import { editError } from "./edit-api.js";

const root = (id: string) => "/comic-drama/series/" + encodeURIComponent(id) + "/director";
const action = (series: string, id: string, choice: "apply" | "dismiss", body: unknown) => request<ComicDirectorProposal>(
  root(series) + "/proposals/" + encodeURIComponent(id) + "/" + choice, { method: "POST", body: JSON.stringify(body) });
export const comicDirectorApi = {
  state: (series: string, signal?: AbortSignal) => request<ComicDirectorState>(root(series), { signal }),
  check: (series: string, signal?: AbortSignal) => request<{ issues: ComicClipCheckIssue[] }>(root(series) + "/check", { signal }),
  chat: (series: string, input: ComicDirectorChatInput, signal?: AbortSignal) => request<ComicDirectorChatResponse>(root(series) + "/chat",
    { method: "POST", body: JSON.stringify(input), signal }),
  import: (series: string, file: File, signal?: AbortSignal) => request<ComicScriptImport>(root(series) + "/import", {
    method: "POST", body: file, signal,
    headers: { "Content-Type": file.name.toLowerCase().endsWith(".docx") ? COMIC_SCRIPT_DOCX : "text/plain" },
  }),
  propose: (series: string, input: ComicDirectorInput, signal?: AbortSignal) => request<ComicDirectorProposal>(root(series) + "/proposals",
    { method: "POST", body: JSON.stringify(input), signal }),
  apply: (series: string, id: string, expectedRevision: number, decision?: ComicDirectorDecision) => action(series, id, "apply", { expectedRevision, decision }),
  dismiss: (series: string, id: string) => action(series, id, "dismiss", {}),
  role: (series: string, id: string, index: number, input: ComicDirectorRoleDecision) => request<ComicDirectorRoleOutcome>(
    root(series) + "/proposals/" + encodeURIComponent(id) + "/roles/" + index, { method: "POST", body: JSON.stringify(input) }),
  quote: (series: string, input: ComicGenerationPreviewRequest, signal: AbortSignal) => request<ComicGenerationQuote>(
    root(series) + "/generation-preview", { method: "POST", body: JSON.stringify(input), signal }),
};

const errors: Record<string, string> = {
  COMIC_SUBMISSIONS_PAUSED: "新生成和导出已暂停",
  COMIC_DIRECTOR_LLM_UNAVAILABLE: "当前账号没有可用的导演文字模型",
  QUOTE_STALE: "素材或分镜已更新，请重新询价",
  DIRECTOR_FILE_TOO_LARGE: "剧本文件最大为 2 MB",
  DIRECTOR_FILE_TYPE: "请选择 TXT 或 DOCX 剧本文件",
  DIRECTOR_FILE_INVALID: "无法读取剧本，请检查文件格式和正文",
  DIRECTOR_BUSY: "本集已有剧本提案正在生成",
  DIRECTOR_ARCHIVED: "归档剧集仅可查看提案",
  DIRECTOR_PROPOSAL_STALE: "剧集已更新，请基于最新修订生成提案",
  REVISION_CONFLICT: "剧集已被其他窗口更新，请刷新后重试",
  CONTENT_COMPLIANCE_REJECTED: "内容未通过安全合规检查，请修改剧本、分镜或台词后重试",
};
export const comicDirectorError = (error: unknown) => error instanceof ApiClientError && error.code ? errors[error.code] ?? editError(error) : editError(error);
