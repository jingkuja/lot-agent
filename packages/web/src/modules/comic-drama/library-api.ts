import type {
  ComicCharacter, ComicCharacterDetail, ComicCharacterInput, ComicCharacterUpload, ComicDictionaryDomain, ComicDictionaryEntry,
  ComicDictionaryUpdate, ComicLabels, ComicLibraryPage, ComicMaterial, ComicMaterialInput, ComicMediaLinks, ComicMediaVersion, ComicOutfit,
} from "@lot-agent/core/comic-drama";
import { request } from "../../api/client.js";

const root = "/comic-drama";
const get = <T>(path: string, signal?: AbortSignal) => request<T>(root + path, { signal });
const write = <T>(path: string, method: string, data?: unknown) =>
  request<T>(root + path, { method, body: data === undefined ? undefined : JSON.stringify(data) });
const query = (params: Record<string, string>) => `?${new URLSearchParams(params)}`;
function upload<T>(path: string, file: File, signal: AbortSignal) {
  const extensions: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", wav: "audio/wav", mp3: "audio/mpeg" };
  const contentType = file.type && file.type !== "application/octet-stream" ? file.type : extensions[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  return request<T>(root + path, { method: "POST", headers: { "Content-Type": contentType || "application/octet-stream" }, body: file, signal });
}

export const comicLibraryApi = {
  characters: (params: Record<string, string>, signal?: AbortSignal) => get<ComicLibraryPage<ComicCharacter>>("/characters" + query(params), signal),
  character: (id: string, signal?: AbortSignal) => get<ComicCharacterDetail>(`/characters/${encodeURIComponent(id)}`, signal),
  createCharacter: (data: ComicCharacterInput) => write<{ id: string }>("/characters", "POST", data),
  editCharacter: (id: string, data: ComicCharacterInput) => write<{ ok: true }>(`/characters/${id}`, "PATCH", data),
  archiveCharacter: (id: string) => write<{ ok: true }>(`/characters/${id}/archive`, "POST"),
  outfit: (id: string, name: string) => write<ComicOutfit>(`/characters/${id}/outfits`, "POST", { name }),
  characterVersions: (id: string, target: ComicCharacterUpload, signal?: AbortSignal) =>
    get<ComicMediaVersion[]>(`/characters/${id}/versions` + query(target), signal),
  characterUpload: (id: string, target: ComicCharacterUpload, file: File, signal: AbortSignal) =>
    upload<{ mediaId: string; version: number }>(`/characters/${id}/files` + query(target), file, signal),
  materials: (params: Record<string, string>, signal?: AbortSignal) => get<ComicLibraryPage<ComicMaterial>>("/materials" + query(params), signal),
  materialUpload: (data: ComicMaterialInput, file: File, signal: AbortSignal) => upload<{ id: string; mediaId: string }>(
    "/materials/upload" + query({ ...data, categoryKey: data.categoryKey ?? "", tags: data.tags.join(",") }), file, signal,
  ),
  replaceMaterial: (id: string, file: File, signal: AbortSignal) => upload<{ mediaId: string; version: number }>(`/materials/${id}/files`, file, signal),
  materialVersions: (id: string, signal?: AbortSignal) => get<ComicMediaVersion[]>(`/materials/${id}/versions`, signal),
  archiveMaterial: (id: string) => write<{ ok: true }>(`/materials/${id}/archive`, "POST"),
  links: (id: string, signal?: AbortSignal) => get<ComicMediaLinks>(`/media/${id}/links`, signal),
  dictionary: (domain: ComicDictionaryDomain, signal?: AbortSignal) => get<ComicDictionaryEntry[]>(`/dictionary/${domain}`, signal),
  addEntry: (domain: ComicDictionaryDomain, key: string, labels: ComicLabels) =>
    write<ComicDictionaryEntry[]>(`/dictionary/${domain}`, "POST", { key, labels }),
  editEntry: (domain: ComicDictionaryDomain, key: string, data: ComicDictionaryUpdate) =>
    write<ComicDictionaryEntry[]>(`/dictionary/${domain}/${key}`, "PATCH", data),
  sort: (domain: ComicDictionaryDomain, keys: string[]) => write<ComicDictionaryEntry[]>(`/dictionary/${domain}/order`, "PUT", { keys }),
};
