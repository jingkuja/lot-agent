import type {
  ComicCharacter, ComicCharacterDetail, ComicCharacterInput, ComicCharacterUpload, ComicDictionaryDomain, ComicDictionaryEntry,
  ComicDictionaryUpdate, ComicLabels, ComicLibraryPage, ComicMaterial, ComicMaterialInput, ComicMaterialUpdate, ComicMediaLinks,
  ComicMediaVersion, ComicOutfit, ComicStylePreset, ComicUserPreferences, ComicUserSettings,
  ComicCharacterDesignVoice, ComicCharacterVoiceDesignInput, ComicLibraryVoice, ComicLibraryVoiceChoices,
} from "@lot-agent/core/comic-drama";
import { request } from "../../api/client.js";

const root = "/comic-drama";
const COMIC_CHOICES_TTL_MS = 60_000;
const choicesCache = new Map<ComicDictionaryDomain, { expiresAt: number; entries: ComicDictionaryEntry[] }>();
const choicesInFlight = new Map<ComicDictionaryDomain, Promise<ComicDictionaryEntry[]>>();

if (typeof window !== "undefined") {
  window.addEventListener("lot:unauthorized", () => {
    choicesCache.clear();
    choicesInFlight.clear();
  });
}

export function getCachedComicChoices(domain: ComicDictionaryDomain): ComicDictionaryEntry[] | undefined {
  const hit = choicesCache.get(domain);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    choicesCache.delete(domain);
    return undefined;
  }
  return hit.entries;
}

export function invalidateComicChoicesCache(domain?: ComicDictionaryDomain): void {
  if (domain) {
    choicesCache.delete(domain);
    choicesInFlight.delete(domain);
  } else {
    choicesCache.clear();
    choicesInFlight.clear();
  }
}

export function loadComicChoices(domain: ComicDictionaryDomain, force = false): Promise<ComicDictionaryEntry[]> {
  if (!force) {
    const cached = getCachedComicChoices(domain);
    if (cached) return Promise.resolve(cached);
    const pending = choicesInFlight.get(domain);
    if (pending) return pending;
  }
  const req = comicLibraryApi.dictionary(domain).then(entries => {
    choicesCache.set(domain, { expiresAt: Date.now() + COMIC_CHOICES_TTL_MS, entries });
    return entries;
  }).finally(() => {
    if (choicesInFlight.get(domain) === req) choicesInFlight.delete(domain);
  });
  choicesInFlight.set(domain, req);
  return req;
}

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
  voiceChoices: (signal?: AbortSignal) => get<ComicLibraryVoiceChoices>("/voices/choices", signal),
  createVoice: (body: FormData, signal: AbortSignal) => request<ComicLibraryVoice>(root + "/voices", { method: "POST", body, signal }),
  refreshVoice: (id: string, signal?: AbortSignal) =>
    request<ComicLibraryVoice>(`${root}/voices/${encodeURIComponent(id)}/refresh`, { method: "POST", signal }),
  designCharacterVoice: (data: ComicCharacterVoiceDesignInput, signal: AbortSignal) =>
    request<ComicCharacterDesignVoice>(root + "/voices/character-design", { method: "POST", body: JSON.stringify(data), signal }),
  refreshCharacterVoice: (id: string, signal: AbortSignal) =>
    request<ComicCharacterDesignVoice>(`${root}/voices/character-design/${encodeURIComponent(id)}/refresh`, { method: "POST", signal }),
  archiveCharacter: (id: string) => write<{ ok: true }>(`/characters/${id}/archive`, "POST"),
  outfit: (id: string, name: string) => write<ComicOutfit>(`/characters/${id}/outfits`, "POST", { name }),
  renameOutfit: (id: string, outfitId: string, name: string) => write<ComicOutfit>(`/characters/${id}/outfits/${outfitId}`, "PATCH", { name }),
  reorderOutfits: (id: string, outfitIds: string[]) => write<ComicOutfit[]>(`/characters/${id}/outfits/order`, "PUT", { outfitIds }),
  deleteOutfit: (id: string, outfitId: string) => write<{ ok: true }>(`/characters/${id}/outfits/${outfitId}`, "DELETE"),
  deleteCharacterAsset: (id: string, target: ComicCharacterUpload) => write<{ ok: true }>(`/characters/${id}/assets`, "DELETE", target),
  characterVersions: (id: string, target: ComicCharacterUpload, signal?: AbortSignal) =>
    get<ComicMediaVersion[]>(`/characters/${id}/versions` + query(target), signal),
  characterUpload: (id: string, target: ComicCharacterUpload, file: File, signal: AbortSignal) =>
    upload<{ mediaId: string; version: number }>(`/characters/${id}/files` + query(target), file, signal),
  materials: (params: Record<string, string>, signal?: AbortSignal) => get<ComicLibraryPage<ComicMaterial>>("/materials" + query(params), signal),
  materialUpload: (data: ComicMaterialInput, file: File, signal: AbortSignal) => upload<{ id: string; mediaId: string }>(
    "/materials/upload" + query({ ...data, categoryKey: data.categoryKey ?? "", tags: data.tags.join(",") }), file, signal,
  ),
  saveMediaAsMaterial: (mediaId: string, material: ComicMaterialInput) =>
    write<{ id: string }>("/materials/from-media", "POST", { mediaId, material }),
  editMaterial: (id: string, data: ComicMaterialUpdate) => write<{ ok: true }>(`/materials/${id}`, "PATCH", data),
  replaceMaterial: (id: string, file: File, signal: AbortSignal) => upload<{ mediaId: string; version: number }>(`/materials/${id}/files`, file, signal),
  materialVersions: (id: string, signal?: AbortSignal) => get<ComicMediaVersion[]>(`/materials/${id}/versions`, signal),
  archiveMaterial: (id: string) => write<{ ok: true }>(`/materials/${id}/archive`, "POST"),
  unarchiveMaterial: (id: string) => write<{ ok: true }>(`/materials/${id}/unarchive`, "POST"),
  deleteMaterial: (id: string) => write<{ ok: true }>(`/materials/${id}`, "DELETE"),
  links: (id: string, signal?: AbortSignal) => get<ComicMediaLinks>(`/media/${id}/links`, signal),
  dictionary: (domain: ComicDictionaryDomain, signal?: AbortSignal) => get<ComicDictionaryEntry[]>(`/dictionary/${domain}`, signal),
  addEntry: async (domain: ComicDictionaryDomain, key: string, labels: ComicLabels) => {
    const result = await write<ComicDictionaryEntry[]>(`/dictionary/${domain}`, "POST", { key, labels });
    invalidateComicChoicesCache(domain);
    return result;
  },
  editEntry: async (domain: ComicDictionaryDomain, key: string, data: ComicDictionaryUpdate) => {
    const result = await write<ComicDictionaryEntry[]>(`/dictionary/${domain}/${key}`, "PATCH", data);
    invalidateComicChoicesCache(domain);
    return result;
  },
  sort: async (domain: ComicDictionaryDomain, keys: string[]) => {
    const result = await write<ComicDictionaryEntry[]>(`/dictionary/${domain}/order`, "PUT", { keys });
    invalidateComicChoicesCache(domain);
    return result;
  },
  settings: (signal?: AbortSignal) => get<ComicUserSettings>("/settings", signal),
  updateSettings: (preferences: ComicUserPreferences) => write<ComicUserPreferences>("/settings", "PUT", preferences),
  bindStyleReference: (styleKey: string, mediaId: string) =>
    write<ComicStylePreset>(`/settings/styles/${encodeURIComponent(styleKey)}/reference`, "PUT", { mediaId }),
  uploadStyleReference: (styleKey: string, file: File, signal: AbortSignal) =>
    upload<ComicStylePreset>(`/settings/styles/${encodeURIComponent(styleKey)}/reference/upload`, file, signal),
  removeStyleReference: (styleKey: string) =>
    write<{ ok: true }>(`/settings/styles/${encodeURIComponent(styleKey)}/reference`, "DELETE"),
};
