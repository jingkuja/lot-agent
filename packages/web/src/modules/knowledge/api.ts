import { getToken, request } from "../../api/client.js";
export interface AccessKey { id: string; name: string; prefix: string; scopes: string[]; collection_ids: string[]; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; version: number }
export interface Collection { id: string; name: string; description: string; tags: string[]; storedCount: number; searchableCount: number; version: number }
export interface Item { sourceAssetId: string | null; id: string; title: string; description: string; tags: string[]; sourceUrl: string | null; version: number; sourceType: string; indexStatus: string; activeRevisionId: string | null; pendingRevisionId: string | null; revisionId: string; taskId: string | null; content: string | null; mime: string | null; size: number; collectionIds: string[] }
export interface Evidence { itemId: string; revisionId: string; chunkId: string; title: string; content: string; origin: string; sourceType: string; citation?: { kind: string; page?: number; paragraph?: number; heading?: string; startLine?: number; endLine?: number } }
export interface Results { modeUsed: string; degraded: boolean; warnings: string[]; results: Evidence[] }
export interface Page<T> { data: T[]; nextCursor: string | null }
export interface Fact { id: string; key: string; value: string | number | boolean | string[]; value_type: string; category: string; source: string; active: boolean; current: boolean; share_with_api: boolean; valid_from: string | null; valid_until: string | null; version: number; collection_ids: string[] }
export interface Candidate { id: string; key: string; value: string | null; operation: string }
export interface Material { id: string; type: string; mime: string; original_name: string | null; size_bytes: number; created_at: string; cursor_time: string; archived_item_id: string | null }
export interface Source { content: string | null; description: string; blocks: Array<{ text: string; citation?: Evidence["citation"] }>; diagnostics: unknown }
export class DuplicateFileError extends Error { constructor(readonly duplicate: { id: string; title: string }) { super("已存在相同原件"); } }
export const fileMime = (file: File) => ({ txt: "text/plain", md: "text/markdown", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm" } as Record<string, string>)[file.name.split(".").at(-1)?.toLowerCase() ?? ""] ?? file.type;
const base = "/rag/manage";
const json = (body: unknown) => JSON.stringify(body);
const headers = () => ({ "Idempotency-Key": crypto.randomUUID() });
export const knowledgeApi = {
  keys: () => request<{ data: AccessKey[] }>(`${base}/keys`),
  createKey: (input: unknown) => request<AccessKey & { token: string }>(`${base}/keys`, { method: "POST", body: json(input) }),
  updateKey: (key: AccessKey, input: object) => request<AccessKey>(`${base}/keys/${key.id}`, { method: "PATCH", body: json({ ...input, version: key.version }) }),
  rotateKey: (key: AccessKey) => request<AccessKey & { token: string }>(`${base}/keys/${key.id}/rotate`, { method: "POST", body: json({ version: key.version }) }),
  revokeKey: (key: AccessKey) => request(`${base}/keys/${key.id}`, { method: "DELETE", body: json({ version: key.version }) }),
  status: () => request<{ ingestionEnabled: boolean; externalEnabled: boolean }>(`${base}/status`),
  storage: () => request<{ storedBytes: number }>(`${base}/storage`),
  collections: (cursor?: string) => request<Page<Collection>>(`${base}/collections${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  createCollection: (name: string) => request<Collection>(`${base}/collections`, { method: "POST", headers: headers(), body: json({ name }) }),
  updateCollection: (collection: Collection, value: { name: string; description: string; tags: string[] }) => request(`${base}/collections/${collection.id}`, { method: "PATCH", body: json({ name: value.name, description: value.description, tags: value.tags, version: collection.version }) }),
  deleteCollection: (collection: Collection) => request(`${base}/collections/${collection.id}`, { method: "DELETE", body: json({ version: collection.version }) }),
  items: (scope: string, cursor?: string, type = "", tag = "", query = "") => {
    const params = new URLSearchParams();
    if (scope === "inbox") params.set("inbox", "true"); else if (scope && scope !== "all") params.set("collectionId", scope);
    if (cursor) params.set("cursor", cursor); if (type) params.set("types", type); if (tag) params.set("tag", tag); if (query) params.set("q", query);
    return request<Page<Item>>(`${base}/items?${params}`);
  },
  item: (id: string) => request<Item>(`${base}/items/${id}`),
  createItem: (value: unknown) => request(`${base}/items`, { method: "POST", headers: headers(), body: json(value) }),
  updateItem: (item: Item, value: unknown) => request(`${base}/items/${item.id}`, { method: "PATCH", body: json({ ...value as object, version: item.version }) }),
  memberships: (itemIds: string[], collectionIds: string[], add: boolean) => request(`${base}/memberships`, { method: "POST", body: json({ itemIds, collectionIds, add }) }),
  upload: (collectionIds: string[], file: File, key: string, progress: (value: number) => void, copy = false) => new Promise<{ id: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open("POST", `/api${base}/uploads`); xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader("Authorization", `Bearer ${getToken() ?? ""}`); xhr.setRequestHeader("Content-Type", fileMime(file));
    xhr.setRequestHeader("Idempotency-Key", key); xhr.setRequestHeader("X-Knowledge-Duplicate-Policy", copy ? "copy" : "ask");
    xhr.setRequestHeader("X-Knowledge-Metadata", encodeURIComponent(json({ title: file.name, collectionIds })));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress(Math.round(e.loaded / e.total * 100)); };
    xhr.onerror = () => reject(new Error("上传连接中断，请重试")); xhr.ontimeout = () => reject(new Error("上传超时，请重试"));
    xhr.onload = () => {
      let data; try { data = JSON.parse(xhr.responseText); } catch { reject(new Error("上传服务返回无效响应")); return; }
      if (xhr.status === 409 && data.duplicate) reject(new DuplicateFileError(data.duplicate));
      else if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error?.message ?? "上传失败，请重试"));
    }; xhr.send(file);
  }),
  replaceFile: (item: Item, file: File) => request(`${base}/items/${item.id}/file`, { method: "PUT", headers: { ...headers(), "Content-Type": fileMime(file), "X-Knowledge-Version": String(item.version) }, body: file }),
  retry: (item: Item) => request(`${base}/items/${item.id}/retry`, { method: "POST", body: json({ version: item.version }) }),
  cancel: (taskId: string) => request(`/tasks/${taskId}/cancel`, { method: "POST" }),
  task: (taskId: string) => request<{ progress: number; stage: string; error?: string }>(`/tasks/${taskId}`),
  remove: (item: Item) => request(`${base}/items/${item.id}`, { method: "DELETE", body: json({ version: item.version }) }),
  text: (itemId: string, revisionId: string) => request<Source>(`${base}/items/${itemId}/revisions/${revisionId}/text`),
  ticket: (itemId: string, revisionId: string) => request<{ url: string }>(`${base}/items/${itemId}/revisions/${revisionId}/preview-ticket`, { method: "POST" }),
  file: async (item: Item) => { const response = await fetch(`/api${base}/items/${item.id}/revisions/${item.revisionId}/content`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } }); if (!response.ok) throw new Error("原件不可用，请刷新后重试"); return new File([await response.blob()], item.title, { type: item.mime ?? "application/octet-stream" }); },
  search: (collectionId: string, query: string, mode: string, allowDegraded: boolean, type = "", tag = "") => request<Results>(`${base}/${collectionId ? "retrieval" : "search"}`, { method: "POST", body: json({ query, collection_ids: collectionId ? [collectionId] : [], mode, allow_degraded: allowDegraded, filters: { source_types: type ? [type] : ["note", "document", "bookmark", "image", "audio", "video", "profile_fact"], ...(tag ? { tags: [tag] } : {}) } }) }),
  facts: () => request<{ data: Fact[] }>(`${base}/profile`),
  saveFact: (value: unknown) => request(`${base}/profile`, { method: "PUT", body: json(value) }),
  candidates: () => request<{ data: Candidate[] }>(`${base}/profile/candidates`),
  resolveCandidate: (id: string, accept: boolean, version: number) => request(`${base}/profile/candidates/${id}`, { method: "POST", body: json({ accept, version }) }),
  history: (id: string) => request<{ data: Array<{ version: number; snapshot: Fact; created_at: string }> }>(`${base}/profile/${id}/history`),
  materials: (before?: string, beforeId?: string) => request<{ data: Material[] }>(`${base}/materials${before ? `?before=${encodeURIComponent(before)}${beforeId ? `&beforeId=${encodeURIComponent(beforeId)}` : ""}` : ""}`),
  materialFile: async (asset: Material) => { const response = await fetch(`/api${base}/materials/${asset.id}/content`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } }); if (!response.ok) throw new Error("原件不可用，请刷新后重试"); return new File([await response.blob()], asset.original_name || `素材-${asset.id}`, { type: asset.mime }); },
  archive: (asset: Material, collectionIds: string[]) => request<{ id: string }>(`${base}/materials/archive`, { method: "POST", headers: headers(), body: json({ assetId: asset.id, title: asset.original_name || `素材-${asset.id}`, collectionIds }) }),
};
