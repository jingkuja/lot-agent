import { createHash } from "node:crypto";
import { fetchPublicBinary } from "@lot-agent/core";
import * as XLSX from "xlsx";

const POSTER_BASE_URL = "https://todoucloud.com/posters/";
const PAGE_SIZE = 24;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const NIGHTLY_REFRESH_UTC_HOUR = 15; // 23:00 Asia/Shanghai
export const POSTER_UNAVAILABLE = "这张爆款参考图已失效，请重新选择";

export interface PosterReference {
  category: string;
  filename: string;
}

export interface CatalogPoster extends PosterReference {
  name: string;
  url: string;
}

function safeName(name: unknown): name is string {
  return typeof name === "string" && !!name && !name.startsWith(".") && !/[\\/\u0000-\u001f\u007f]/.test(name)
    && Buffer.byteLength(name) <= 255 && Buffer.from(name).toString() === name;
}

export function parsePosterReference(value: unknown): PosterReference | null {
  if (!value || typeof value !== "object") return null;
  const { category, filename } = value as Record<string, unknown>;
  if (!safeName(category) || !safeName(filename) || !/\.(jpe?g|png|webp|gif)$/i.test(filename)) return null;
  return { category, filename };
}

export function posterImageUrl({ category, filename }: PosterReference, revision: string): string {
  return `${POSTER_BASE_URL}${encodeURIComponent(category)}/${encodeURIComponent(filename)}?v=${encodeURIComponent(revision)}`;
}

function parseCatalog(csv: string, revision: string): Map<string, Map<string, CatalogPoster>> {
  const source = csv.replace(/^\uFEFF/, "");
  if (!/^(品类|"品类"),/.test(source)) throw new Error("Missing poster CSV header");
  const workbook = XLSX.read(source, { type: "string", raw: true, FS: "," });
  const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, blankrows: false });
  const [header = [], ...records] = rows;
  const pathIndex = header.indexOf("图片本地路径");
  if (pathIndex < 0) throw new Error("Missing local image path column");
  const nameIndex = header.indexOf("商品名");
  const categories = new Map<string, Map<string, CatalogPoster>>();
  for (const row of records) {
    const path = row[pathIndex]?.trim();
    const parts = path && /^\/workspace\/posters\/([^/]+)\/([^/]+)$/.exec(path);
    const reference = parts && parsePosterReference({ category: parts[1], filename: parts[2] });
    if (!reference) continue;
    const { category, filename } = reference;
    const items = categories.get(category) ?? new Map<string, CatalogPoster>();
    if (!items.has(filename)) {
      items.set(filename, { ...reference, name: row[nameIndex]?.trim() || filename, url: posterImageUrl(reference, revision) });
    }
    categories.set(category, items);
  }
  if (records.length && !categories.size) throw new Error("No valid image paths in poster CSV");
  return categories;
}

function fetchIndex(signal?: AbortSignal) {
  return fetchPublicBinary(`${POSTER_BASE_URL}index.csv`, {
    maxBytes: MAX_INDEX_BYTES, maxRedirects: 0, timeoutMs: 15_000, signal,
  }).then(({ body }) => body.toString("utf8"));
}

/** One snapshot serves the gallery and validates selections until a complete refresh is available. */
export class PosterLibrary {
  private snapshot?: { revision: string; categories: Map<string, Map<string, CatalogPoster>> };

  constructor(private readonly loadIndex = fetchIndex) {}

  async refresh(signal?: AbortSignal): Promise<void> {
    const csv = await this.loadIndex(signal);
    signal?.throwIfAborted();
    const revision = createHash("sha256").update(csv).digest("hex").slice(0, 16);
    const categories = parseCatalog(csv, revision);
    this.snapshot = { revision, categories };
  }

  categories(): string[] | undefined {
    return this.snapshot && [...this.snapshot.categories.keys()];
  }

  page(category: string, offset: number) {
    if (!this.snapshot) return undefined;
    const group = this.snapshot.categories.get(category);
    if (!group) return null;
    const end = offset + PAGE_SIZE;
    return { items: [...group.values()].slice(offset, end), nextOffset: end < group.size ? end : null };
  }

  select(reference: PosterReference): (PosterReference & { revision: string }) | null | undefined {
    const snapshot = this.snapshot;
    if (!snapshot) return undefined;
    return snapshot.categories.get(reference.category)?.has(reference.filename) ? { ...reference, revision: snapshot.revision } : null;
  }
}

export function startPosterLibraryRefresh(library: PosterLibrary): () => void {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const refresh = async () => {
    try {
      await library.refresh(controller.signal);
    } catch {
      if (!controller.signal.aborted) console.warn("[poster-library] index refresh failed");
    }
    if (controller.signal.aborted) return;
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(NIGHTLY_REFRESH_UTC_HOUR, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    timer = setTimeout(() => void refresh(), next.getTime() - now.getTime()).unref();
  };
  void refresh();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
