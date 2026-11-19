import {
  COMIC_SCRIPT_DOCX, type ComicDirectorInput, type ComicDirectorProposal, type ComicDirectorState, type ComicScriptImport,
} from "@lot-agent/core/comic-drama";
import { ApiClientError, request } from "../../api/client.js";
import { editError } from "./edit-api.js";

const root = (id: string) => "/comic-drama/series/" + encodeURIComponent(id) + "/director";
const action = (series: string, id: string, choice: "apply" | "dismiss", body: unknown) => request<ComicDirectorProposal>(
  root(series) + "/proposals/" + encodeURIComponent(id) + "/" + choice, { method: "POST", body: JSON.stringify(body) });
export const comicDirectorApi = {
  state: (series: string, signal?: AbortSignal) => request<ComicDirectorState>(root(series), { signal }),
  import: (series: string, file: File, signal?: AbortSignal) => request<ComicScriptImport>(root(series) + "/import", {
    method: "POST", body: file, signal,
    headers: { "Content-Type": file.name.toLowerCase().endsWith(".docx") ? COMIC_SCRIPT_DOCX : "text/plain" },
  }),
  propose: (series: string, input: ComicDirectorInput, signal?: AbortSignal) => request<ComicDirectorProposal>(root(series) + "/proposals",
    { method: "POST", body: JSON.stringify(input), signal }),
  apply: (series: string, id: string, expectedRevision: number) => action(series, id, "apply", { expectedRevision }),
  dismiss: (series: string, id: string) => action(series, id, "dismiss", {}),
};

const errors: Record<string, string> = {
  DIRECTOR_FILE_TOO_LARGE: "剧本文件最大为 2 MB",
  DIRECTOR_FILE_TYPE: "请选择 TXT 或 DOCX 剧本文件",
  DIRECTOR_FILE_INVALID: "无法读取剧本，请检查文件格式和正文",
  DIRECTOR_BUSY: "本集已有剧本提案正在生成",
  DIRECTOR_ARCHIVED: "归档剧集仅可查看提案",
  DIRECTOR_PROPOSAL_STALE: "剧集已更新，请基于最新修订生成提案",
  REVISION_CONFLICT: "剧集已更新，请基于最新修订生成提案",
};
export const comicDirectorError = (error: unknown) => error instanceof ApiClientError && error.code ? errors[error.code] ?? editError(error) : editError(error);
