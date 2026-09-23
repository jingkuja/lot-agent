import { request } from "../../api/client.js";
export interface Collection { id: string; name: string; storedCount: number; searchableCount: number; version: number }
export interface Item { id: string; title: string; version: number; sourceType: string; indexStatus: string; activeRevisionId: string | null; pendingRevisionId: string | null; revisionId: string; taskId: string | null; content: string | null; mime: string | null; collectionIds: string[] }
export interface Evidence { itemId: string; revisionId: string; chunkId: string; title: string; content: string; origin: string; sourceType: string; citation?: { kind: string; page?: number; paragraph?: number; heading?: string; startLine?: number; endLine?: number } }
export interface Results { modeUsed: string; degraded: boolean; warnings: string[]; results: Evidence[] }
export interface Page<T> { data: T[]; nextCursor: string | null }
const base = "/rag/manage";
const json = (body: unknown) => JSON.stringify(body);
export const knowledgeApi = {
  status: () => request<{ ingestionEnabled: boolean }>(`${base}/status`),
  collections: (cursor?: string) => request<Page<Collection>>(`${base}/collections${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  createCollection: (name: string) => request<Collection>(`${base}/collections`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: json({ name }) }),
  items: (collectionId: string, cursor?: string) => request<Page<Item>>(`${base}/items?collectionId=${collectionId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  item: (id: string) => request<Item>(`${base}/items/${id}`),
  note: (collectionId: string, title: string, content: string) => request(`${base}/items`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: json({ sourceType: "note", title, content, collectionIds: [collectionId] }) }),
  upload: (collectionId: string, file: File) => {
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    const mime = ({ txt: "text/plain", md: "text/markdown", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } as Record<string, string>)[extension ?? ""];
    if (!mime) throw new Error("请选择 TXT、Markdown、PDF 或 DOCX 文件");
    return request(`${base}/uploads`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID(), "Content-Type": mime,
      "X-Knowledge-Metadata": encodeURIComponent(json({ title: file.name, collectionIds: [collectionId] })) }, body: file });
  },
  retry: (item: Item) => request(`${base}/items/${item.id}/retry`, { method: "POST", body: json({ version: item.version }) }),
  cancel: (taskId: string) => request(`/tasks/${taskId}/cancel`, { method: "POST" }),
  task: (taskId: string) => request<{ progress: number; stage: string; error?: string }>(`/tasks/${taskId}`),
  remove: (item: Item) => request(`${base}/items/${item.id}`, { method: "DELETE", body: json({ version: item.version }) }),
  ticket: (itemId: string, revisionId: string) => request<{ url: string }>(`${base}/items/${itemId}/revisions/${revisionId}/preview-ticket`, { method: "POST" }),
  search: (collectionId: string, query: string, mode: string, allowDegraded: boolean) => request<Results>(`${base}/retrieval`, { method: "POST", body: json({ query, collection_ids: [collectionId], mode, allow_degraded: allowDegraded, filters: { source_types: ["note", "document", "bookmark", "image", "audio", "video"] } }) }),
};
