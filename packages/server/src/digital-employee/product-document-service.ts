import { createHash } from "node:crypto";
import type { JobQueue } from "@lot-agent/core";
import type { Pool } from "pg";
import { isSafeUploadKey } from "../services/attachment-extractor.js";
import { InputError, NotFoundError } from "./errors.js";
import { resolveProductMention, type NamedProduct } from "./product-match.js";

export const PRODUCT_DOCUMENT_JOB = "employee.product_document.parse";
/** A talk track leaves room for customer context; one product's documents may fill the rest. */
export const PRODUCT_DOCUMENT_CHAR_LIMIT = 15_000;
const READ_PAGE_CHARS = 12_000;
const STALLED_MS = 15 * 60 * 1000;
const CATALOG_LIMIT = 200;
const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const READABLE_MIMES = new Set([
  "application/pdf", "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const LIST_COLUMNS = `id, product_id, title, mime, status, error_code, prompt_chars, content_hash, skipped_pages, created_at, updated_at`;

export type ProductDocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface ProductDocument {
  id: string;
  productId: string;
  title: string;
  mime: string;
  status: ProductDocumentStatus;
  errorCode: string | null;
  chars: number;
  /** Pages with no text layer, which this version cannot read. */
  skippedPages: number;
  usedInTalkTrack: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductDocumentList {
  items: ProductDocument[];
  usage: { usedChars: number; limitChars: number };
}

export interface PromptDocument {
  product: string;
  title: string;
  content: string;
}

interface ParsedDocument {
  blocks: Array<{ text: string; citation?: { kind?: string; page?: number } }>;
  diagnostics: string[];
  parserVersion: string;
}

/** Bound in the worker, so the module never reaches the parser or the upload folder itself. */
export type ProductDocumentParser = (file: { storageKey: string; mime: string }, signal?: AbortSignal) => Promise<ParsedDocument>;

function promptChars(text: string): number {
  return JSON.stringify(text).length;
}

/** Page markers stay in the text so answers and later imports can say where a fact came from. */
export function documentText(parsed: ParsedDocument): { text: string; skippedPages: number } {
  let page: number | undefined;
  const lines: string[] = [];
  for (const block of parsed.blocks) {
    if (block.citation?.kind === "pdf" && block.citation.page !== page) {
      page = block.citation.page;
      lines.push(`[Page ${page}]`);
    }
    lines.push(block.text);
  }
  return {
    text: lines.join("\n").trim(),
    skippedPages: parsed.diagnostics.filter((item) => item.startsWith("OCR_REQUIRED_PAGE_")).length,
  };
}

/** Newest first, whole documents only: a file that does not fit is left out, never cut. */
export function fitDocuments<T extends { chars: number; hash?: string | null }>(documents: readonly T[], limit: number): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  let used = 0;
  for (const document of documents) {
    if (document.hash && seen.has(document.hash)) continue;
    if (used + document.chars > limit) continue;
    if (document.hash) seen.add(document.hash);
    used += document.chars;
    kept.push(document);
  }
  return kept;
}

function stalled(row: Record<string, any>, now: number): boolean {
  return (row.status === "pending" || row.status === "processing") && now - new Date(row.updated_at).getTime() > STALLED_MS;
}

function toDocument(row: Record<string, any>, usedIds: Set<string>, now: number): ProductDocument {
  const lost = stalled(row, now);
  return {
    id: row.id, productId: row.product_id, title: row.title, mime: row.mime,
    status: lost ? "failed" : row.status,
    errorCode: lost ? "PARSE_STALLED" : row.error_code,
    chars: Number(row.prompt_chars), skippedPages: Number(row.skipped_pages),
    usedInTalkTrack: usedIds.has(row.id),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class ProductDocumentService {
  constructor(private readonly pool: Pool, private readonly queue?: JobQueue) {}

  private async requireActiveProduct(userId: string, productId: string): Promise<{ id: string; name: string }> {
    const { rows } = await this.pool.query(
      `SELECT id, name FROM marketing_products WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [productId, userId]
    );
    if (!rows[0]) throw new NotFoundError("未找到该产品资料");
    return rows[0];
  }

  async list(userId: string, productId: string): Promise<ProductDocumentList> {
    await this.requireActiveProduct(userId, productId);
    const { rows } = await this.pool.query(
      `SELECT ${LIST_COLUMNS} FROM marketing_product_documents
       WHERE user_id = $1 AND product_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
      [userId, productId]
    );
    const ready = rows.filter((row) => row.status === "ready")
      .map((row) => ({ id: String(row.id), chars: Number(row.prompt_chars), hash: row.content_hash as string | null }));
    const fitted = fitDocuments(ready, PRODUCT_DOCUMENT_CHAR_LIMIT);
    const now = Date.now();
    return {
      items: rows.map((row) => toDocument(row, new Set(fitted.map((item) => item.id)), now)),
      usage: { usedChars: fitted.reduce((sum, item) => sum + item.chars, 0), limitChars: PRODUCT_DOCUMENT_CHAR_LIMIT },
    };
  }

  async add(userId: string, productId: string, input: { assetId: string; title?: string }): Promise<ProductDocument> {
    await this.requireActiveProduct(userId, productId);
    const asset = (await this.pool.query(
      `SELECT id, mime, original_name, storage_key FROM assets WHERE id = $1 AND user_id = $2 AND type = 'upload'`,
      [input.assetId, userId]
    )).rows[0];
    if (!asset) throw new NotFoundError("未找到上传的文件");
    const mime = String(asset.mime ?? "");
    if (!READABLE_MIMES.has(mime) && !mime.startsWith("text/")) throw new InputError("这种文件暂时读不了，可以上传 PDF、Word、PPT、Excel 或文本文件");
    if (!isSafeUploadKey(String(asset.storage_key))) throw new InputError("文件无法读取");
    const title = (input.title?.trim() || String(asset.original_name ?? "").trim() || "补充资料").slice(0, 300);
    const { rows } = await this.pool.query(
      `INSERT INTO marketing_product_documents (user_id, product_id, asset_id, title, mime)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${LIST_COLUMNS}`,
      [userId, productId, asset.id, title, mime]
    );
    return this.enqueue(userId, rows[0]);
  }

  async retry(userId: string, productId: string, documentId: string): Promise<ProductDocument> {
    const { rows } = await this.pool.query(
      `UPDATE marketing_product_documents SET status = 'pending', error_code = NULL, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND product_id = $3 AND deleted_at IS NULL
         AND (status = 'failed' OR (status IN ('pending', 'processing') AND updated_at < now() - interval '15 minutes'))
       RETURNING ${LIST_COLUMNS}`,
      [documentId, userId, productId]
    );
    if (!rows[0]) throw new NotFoundError("这份资料不需要重试");
    return this.enqueue(userId, rows[0]);
  }

  private async enqueue(userId: string, row: Record<string, any>): Promise<ProductDocument> {
    try {
      if (!this.queue) throw new Error("queue unavailable");
      await this.queue.enqueue(PRODUCT_DOCUMENT_JOB, { documentId: row.id }, userId, { maxAttempts: 1 });
      return toDocument(row, new Set(), Date.now());
    } catch (error) {
      console.warn("[product-document] enqueue failed:", error instanceof Error ? error.name : "unknown");
      await this.pool.query(
        `UPDATE marketing_product_documents SET status = 'failed', error_code = 'QUEUE_UNAVAILABLE', updated_at = now() WHERE id = $1 AND user_id = $2`,
        [row.id, userId]
      );
      return toDocument({ ...row, status: "failed", error_code: "QUEUE_UNAVAILABLE" }, new Set(), Date.now());
    }
  }

  async remove(userId: string, productId: string, documentId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE marketing_product_documents SET deleted_at = now(), parsed_text = NULL, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND product_id = $3 AND deleted_at IS NULL`,
      [documentId, userId, productId]
    );
    if (!rowCount) throw new NotFoundError("未找到这份资料");
  }

  async parse(userId: string, documentId: string, parser: ProductDocumentParser, signal?: AbortSignal): Promise<void> {
    const claimed = (await this.pool.query(
      `UPDATE marketing_product_documents document SET status = 'processing', updated_at = now()
       FROM (SELECT id, storage_key FROM assets) asset
       WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL AND document.status IN ('pending', 'processing')
         AND asset.id = document.asset_id
       RETURNING document.mime, asset.storage_key`,
      [documentId, userId]
    )).rows[0];
    if (!claimed) {
      await this.finishFailed(userId, documentId, "SOURCE_MISSING");
      return;
    }
    try {
      const parsed = await parser({ storageKey: claimed.storage_key, mime: claimed.mime }, signal);
      const { text, skippedPages } = documentText(parsed);
      if (!text) throw new Error("EMPTY_TEXT");
      await this.pool.query(
        `UPDATE marketing_product_documents
         SET status = 'ready', error_code = NULL, parsed_text = $3, prompt_chars = $4, content_hash = $5,
             skipped_pages = $6, parser_version = $7, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [documentId, userId, text, promptChars(text), createHash("sha256").update(text).digest("hex"), skippedPages, parsed.parserVersion]
      );
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : "PARSE_FAILED";
      await this.finishFailed(userId, documentId, code);
    }
  }

  private async finishFailed(userId: string, documentId: string, code: string): Promise<void> {
    await this.pool.query(
      `UPDATE marketing_product_documents SET status = 'failed', error_code = $3, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND status IN ('pending', 'processing')`,
      [documentId, userId, code]
    );
  }

  /** Documents for a prompt, in product order; `room` is what the prompt has left. */
  async forPrompt(userId: string, products: readonly NamedProduct[], room: number): Promise<PromptDocument[]> {
    if (!products.length || room <= 0) return [];
    const limit = Math.min(room, PRODUCT_DOCUMENT_CHAR_LIMIT);
    const { rows } = await this.pool.query(
      `SELECT product_id, title, parsed_text, content_hash FROM marketing_product_documents
       WHERE user_id = $1 AND product_id = ANY($2::uuid[]) AND status = 'ready' AND deleted_at IS NULL AND prompt_chars <= $3
       ORDER BY array_position($2::uuid[], product_id), created_at DESC, id DESC`,
      [userId, products.map((product) => product.id), limit]
    );
    const names = new Map(products.map((product) => [product.id, product.name]));
    const candidates = rows.map((row) => {
      const document = { product: names.get(row.product_id) ?? "", title: row.title as string, content: row.parsed_text as string };
      return { document, chars: JSON.stringify(document).length + 1, hash: row.content_hash as string | null };
    });
    return fitDocuments(candidates, limit).map((item) => item.document);
  }

  /** Accepts an id or whatever the user called the product. */
  async resolveProduct(userId: string, reference: string): Promise<{ product: NamedProduct | null; candidates: NamedProduct[] }> {
    if (ENTITY_ID.test(reference)) {
      const { rows } = await this.pool.query(
        `SELECT id, name FROM marketing_products WHERE id = $1 AND user_id = $2 AND status = 'active'`, [reference, userId]
      );
      return { product: rows[0] ?? null, candidates: [] };
    }
    const { rows } = await this.pool.query(
      `SELECT id, name FROM marketing_products WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT ${CATALOG_LIMIT}`,
      [userId]
    );
    const { matches } = resolveProductMention(reference, rows as NamedProduct[]);
    if (matches.length === 1) return { product: matches[0], candidates: [] };
    return { product: null, candidates: matches.length ? matches : rows.slice(0, 20) };
  }

  /** One page of a document, so a long manual can still be read in the conversation. */
  async read(userId: string, productId: string, input: { documentId?: string; offset?: number } = {}) {
    const { items } = await this.list(userId, productId);
    const ready = items.filter((item) => item.status === "ready");
    const documents = items.map(({ id, title, status, chars, skippedPages }) => ({ id, title, status, chars, skippedPages }));
    const target = input.documentId ? ready.find((item) => item.id === input.documentId) : ready[0];
    if (!target) return { documents, document: null };
    const { rows } = await this.pool.query(
      `SELECT parsed_text FROM marketing_product_documents WHERE id = $1 AND user_id = $2 AND product_id = $3 AND deleted_at IS NULL`,
      [target.id, userId, productId]
    );
    const text = String(rows[0]?.parsed_text ?? "");
    const offset = Math.max(0, input.offset ?? 0);
    const end = offset + READ_PAGE_CHARS;
    return {
      documents,
      document: { id: target.id, title: target.title, text: text.slice(offset, end), nextOffset: end < text.length ? end : null },
    };
  }

  /** What the conversation sees alongside each product, without any document text. */
  async summaries(userId: string, productIds: string[]): Promise<Map<string, Array<{ id: string; title: string; status: string }>>> {
    const result = new Map<string, Array<{ id: string; title: string; status: string }>>();
    if (!productIds.length) return result;
    const { rows } = await this.pool.query(
      `SELECT id, product_id, title, status FROM marketing_product_documents
       WHERE user_id = $1 AND product_id = ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY created_at DESC`,
      [userId, productIds]
    );
    for (const row of rows) {
      result.set(row.product_id, [...(result.get(row.product_id) ?? []), { id: row.id, title: row.title, status: row.status }]);
    }
    return result;
  }
}
