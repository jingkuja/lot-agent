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
  width?: number;
  height?: number;
}

export type PosterOrientation = "all" | "portrait" | "landscape" | "square";

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
  const widthIndex = header.findIndex(name => name === "宽度" || name === "width");
  const heightIndex = header.findIndex(name => name === "高度" || name === "height");
  const categories = new Map<string, Map<string, CatalogPoster>>();
  for (const row of records) {
    const path = row[pathIndex]?.trim();
    const parts = path && /^\/workspace\/posters\/([^/]+)\/([^/]+)$/.exec(path);
    const reference = parts && parsePosterReference({ category: parts[1], filename: parts[2] });
    if (!reference) continue;
    const { category, filename } = reference;
    const items = categories.get(category) ?? new Map<string, CatalogPoster>();
    if (!items.has(filename)) {
      const width = Number(row[widthIndex]), height = Number(row[heightIndex]);
      const dimensions = Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 ? { width, height } : {};
      items.set(filename, { ...reference, name: row[nameIndex]?.trim() || filename, url: posterImageUrl(reference, revision), ...dimensions });
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
  private pending?: Promise<void>;
  private failures = 0;
  private nextAttempt = 0;
  private stopped = false;
  private controller = new AbortController();

  constructor(private readonly loadIndex = fetchIndex, private readonly random = Math.random) {}

  refresh(signal?: AbortSignal): Promise<void> {
    if (this.pending) return this.pending;
    signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.pending = this.loadIndex(signal).then(csv => {
      signal?.throwIfAborted();
      if (this.stopped) return;
      const revision = createHash("sha256").update(csv).digest("hex").slice(0, 16);
      const categories = parseCatalog(csv, revision);
      this.snapshot = { revision, categories };
      this.failures = 0;
      this.nextAttempt = 0;
    }).catch(error => {
      const delays = [30_000, 120_000, 600_000, 1_800_000];
      const delay = delays[Math.min(this.failures++, delays.length - 1)];
      this.nextAttempt = Date.now() + Math.round(delay * (0.9 + this.random() * 0.2));
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  retryDelay(): number { return Math.max(0, this.nextAttempt - Date.now()); }
  async ensureAvailable(signal?: AbortSignal) {
    if (!this.snapshot && !this.stopped && !this.retryDelay()) await this.refresh(signal).catch(() => {});
  }
  stop() { this.stopped = true; this.controller.abort(); }

  categories(): string[] | undefined {
    return this.snapshot && [...this.snapshot.categories.keys()];
  }

  hasDimensions(): boolean {
    return !!this.snapshot && [...this.snapshot.categories.values()].some(group => [...group.values()].some(item => item.width && item.height));
  }

  page(category: string, offset: number, query = "", orientation: PosterOrientation = "all") {
    if (!this.snapshot) return undefined;
    const group = this.snapshot.categories.get(category);
    if (!group) return null;
    const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
    const items = [...group.values()].filter(item => {
      if (!item.name.normalize("NFKC").toLocaleLowerCase().includes(normalized)) return false;
      if (orientation === "all") return true;
      if (!item.width || !item.height) return false;
      return orientation === "square" ? item.width === item.height
        : orientation === "landscape" ? item.width > item.height : item.width < item.height;
    });
    const end = offset + PAGE_SIZE;
    return { items: items.slice(offset, end), nextOffset: end < items.length ? end : null };
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
    let failed = false;
    try {
      await library.refresh(controller.signal);
    } catch {
      failed = true;
      if (!controller.signal.aborted) console.warn("[poster-library] index refresh failed");
    }
    if (controller.signal.aborted) return;
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(NIGHTLY_REFRESH_UTC_HOUR, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    timer = setTimeout(() => void refresh(), failed ? library.retryDelay() : next.getTime() - now.getTime()).unref();
  };
  void refresh();
  return () => {
    controller.abort();
    library.stop();
    clearTimeout(timer);
  };
}
