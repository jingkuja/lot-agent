import type { Pool } from "pg";
import { ConversationActionDrafts, type ConversationActionDraft } from "./conversation-drafts.js";
import { InputError, NotFoundError } from "./errors.js";
import { DIGITAL_EMPLOYEE_UNIFIED_SCOPE } from "./feature-scope.js";
import { DIGITAL_EMPLOYEE_LLM_UNAVAILABLE, MANAGED_CREDENTIAL_UNAVAILABLE } from "./llm.js";
import type { MarketingMaterialsService } from "./marketing-service.js";
import type { MarketingProduct } from "./marketing-types.js";
import { parseMarketingProduct, parseMarketingProductUpdate } from "./marketing-validators.js";
import type { ProductDocumentService } from "./product-document-service.js";
import {
  IMPORT_INPUT_CHARS, PRODUCT_IMPORT_KIND, applyImportEdits, buildImportDraft, importPreview, importedFields, splitUnattended,
  type ImportCommitInput, type ImportDraft, type ImportModelProduct, type ImportPreview, type ImportProduct, type ImportPromptInput,
} from "./product-import.js";
import { confidentProductMatch, normalizedProductName } from "./product-match.js";

export type ProductImportGenerator = (input: ImportPromptInput & { userId: string; signal?: AbortSignal }) => Promise<ImportModelProduct[]>;

export type ProductImportState = "working" | "ready" | "failed";

export interface ProductImportStatus {
  id: string;
  title: string;
  status: ProductImportState;
  errorCode: string | null;
  draftId: string | null;
  preview: ImportPreview | null;
  /** Pictures read so far on a file still being worked on. */
  pagesRead: number;
  createdAt: string;
}

export interface ProductImportResult {
  alreadyApplied: boolean;
  entityId: string | null;
  managementUrl: string;
  saved: Array<{ id: string; name: string; created: boolean; items: number }>;
  /** Selected items that did not fit the product's field limits. */
  dropped: number;
}

export interface UnattendedImportResult extends ProductImportResult {
  /** Items that wait for the owner in a new draft. */
  held: number;
  reviewUrl: string | null;
}

const STALLED_MINUTES = 15;
const CATALOG_LIMIT = 100;
const MANAGEMENT_URL = "/digital-employee/materials";
const COLUMNS = `document.id, document.title, document.status, document.error_code, document.import_status, document.import_error,
  document.import_draft_id, document.product_id, document.created_at, document.updated_at, draft.preview, draft.status AS draft_status, draft.expires_at,
  (SELECT count(*) FROM jsonb_object_keys(document.ocr_pages)) AS pages_read`;
const JOINED = `marketing_product_documents document LEFT JOIN de_conversation_action_drafts draft
  ON draft.id = document.import_draft_id AND draft.user_id = document.user_id`;
const OPEN_DRAFT = `(document.import_status <> 'ready' OR (draft.status IN ('prepared', 'awaiting_confirmation') AND draft.expires_at > now()))`;

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === DIGITAL_EMPLOYEE_LLM_UNAVAILABLE || message === MANAGED_CREDENTIAL_UNAVAILABLE) return "MODEL_UNAVAILABLE";
  if (error instanceof SyntaxError || message === "product import has no products") return "MODEL_OUTPUT_INVALID";
  return "MODEL_FAILED";
}

function toStatus(row: Record<string, any>): ProductImportStatus {
  const stalled = (row.import_status === "queued" || row.import_status === "running")
    && Date.now() - new Date(row.updated_at).getTime() > STALLED_MINUTES * 60_000;
  const parseFailed = row.status === "failed";
  const failed = stalled || parseFailed || row.import_status === "failed";
  return {
    id: row.id,
    title: row.title,
    status: failed ? "failed" : row.import_status === "ready" ? "ready" : "working",
    errorCode: !failed ? null : stalled ? "PARSE_STALLED" : (row.error_code ?? row.import_error ?? "PARSE_FAILED"),
    draftId: !failed ? row.import_draft_id ?? null : null,
    preview: !failed && row.import_status === "ready" ? row.preview ?? null : null,
    pagesRead: Number(row.pages_read ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Sorts a file into a reviewable draft. Nothing reaches a product until the owner saves the review. */
export class ProductImportService {
  private readonly drafts: ConversationActionDrafts;

  constructor(
    private readonly pool: Pool,
    private readonly materials: Pick<MarketingMaterialsService, "listProducts" | "getProduct" | "createProduct" | "updateProduct">,
    private readonly documents: Pick<ProductDocumentService, "addForImport" | "dispatch">,
  ) {
    this.drafts = new ConversationActionDrafts(pool);
  }

  /** Sending the same file twice reads it once: the model call is paid by the owner. */
  async start(userId: string, input: { assetId: string; productId?: string; conversationId?: string }): Promise<ProductImportStatus> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM ${JOINED}
       WHERE document.user_id = $1 AND document.asset_id = $2 AND document.deleted_at IS NULL
         AND document.product_id IS NOT DISTINCT FROM $3 AND document.import_status IN ('queued', 'running', 'ready') AND ${OPEN_DRAFT}
       ORDER BY document.created_at DESC LIMIT 1`,
      [userId, input.assetId, input.productId ?? null]
    );
    if (rows[0] && toStatus(rows[0]).status !== "failed") return toStatus(rows[0]);
    const document = await this.documents.addForImport(userId, input);
    return this.get(userId, document.id);
  }

  /** Sorts a file already on a product's list. The job only runs the import half. */
  async startFromDocument(userId: string, productId: string, documentId: string): Promise<ProductImportStatus> {
    const { rows } = await this.pool.query(
      `UPDATE marketing_product_documents SET import_status = 'queued', import_error = NULL, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND product_id = $3 AND status = 'ready' AND deleted_at IS NULL AND import_status IN ('none', 'failed')
       RETURNING id`,
      [documentId, userId, productId]
    );
    if (!rows[0]) throw new NotFoundError("这份资料现在不能整理");
    return this.queue(userId, documentId);
  }

  private async queue(userId: string, documentId: string): Promise<ProductImportStatus> {
    if (!await this.documents.dispatch(userId, documentId)) {
      await this.pool.query(
        `UPDATE marketing_product_documents SET import_status = 'failed', import_error = 'QUEUE_UNAVAILABLE', updated_at = now() WHERE id = $1 AND user_id = $2`,
        [documentId, userId]
      );
    }
    return this.get(userId, documentId);
  }

  async list(userId: string): Promise<ProductImportStatus[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM ${JOINED}
       WHERE document.user_id = $1 AND document.deleted_at IS NULL AND document.import_status <> 'none' AND ${OPEN_DRAFT}
       ORDER BY document.created_at DESC LIMIT 20`,
      [userId]
    );
    return rows.map(toStatus);
  }

  async get(userId: string, documentId: string): Promise<ProductImportStatus> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM ${JOINED} WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL`, [
      documentId, userId,
    ]);
    if (!rows[0]) throw new NotFoundError("未找到这次导入");
    return toStatus(rows[0]);
  }

  async review(userId: string, documentId: string): Promise<{ status: ProductImportStatus; draft: ImportDraft | null }> {
    const status = await this.get(userId, documentId);
    if (status.status !== "ready" || !status.draftId) return { status, draft: null };
    const draft = await this.drafts.get(userId, status.draftId, PRODUCT_IMPORT_KIND);
    return { status, draft: draft.payload as unknown as ImportDraft };
  }

  async retry(userId: string, documentId: string): Promise<ProductImportStatus> {
    const { rows } = await this.pool.query(
      `UPDATE marketing_product_documents
       SET status = CASE WHEN status = 'ready' THEN status ELSE 'pending' END,
           error_code = CASE WHEN status = 'ready' THEN error_code END,
           import_status = 'queued', import_error = NULL, import_draft_id = NULL, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         AND (import_status = 'failed' OR status = 'failed' OR (import_status IN ('queued', 'running') AND updated_at < now() - interval '${STALLED_MINUTES} minutes'))
       RETURNING id`,
      [documentId, userId]
    );
    if (!rows[0]) throw new NotFoundError("这次导入不需要重试");
    return this.queue(userId, documentId);
  }

  /** Clears a failed or finished import off the list. A file with no product goes with it. */
  async discard(userId: string, documentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE marketing_product_documents
       SET import_status = 'none', import_error = NULL, updated_at = now(),
           deleted_at = CASE WHEN product_id IS NULL THEN now() ELSE deleted_at END,
           parsed_text = CASE WHEN product_id IS NULL THEN NULL ELSE parsed_text END, ocr_pages = '{}'::jsonb
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [documentId, userId]
    );
  }

  /** The worker's half: runs once per queued import and never resends a failed model call. */
  async run(userId: string, documentId: string, generate: ProductImportGenerator, signal?: AbortSignal): Promise<void> {
    const claimed = (await this.pool.query(
      `UPDATE marketing_product_documents SET import_status = 'running', updated_at = now()
       WHERE id = $1 AND user_id = $2 AND import_status = 'queued' AND status = 'ready' AND deleted_at IS NULL
       RETURNING title, parsed_text, product_id, skipped_pages, import_conversation_id`,
      [documentId, userId]
    )).rows[0];
    if (!claimed) {
      await this.pool.query(
        `UPDATE marketing_product_documents SET import_status = 'failed', import_error = error_code, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND import_status = 'queued' AND status = 'failed'`,
        [documentId, userId]
      );
      return;
    }
    try {
      const text = String(claimed.parsed_text ?? "");
      const { items: catalog } = await this.materials.listProducts(userId, { page: 1, limit: CATALOG_LIMIT, status: "active" });
      const target = claimed.product_id ? await this.materials.getProduct(userId, claimed.product_id) : null;
      const entries = await generate({ userId, title: claimed.title, text, catalog: catalog.map((product) => product.name), target, signal });
      const draft = buildImportDraft(entries, {
        documentId, title: claimed.title, sourceText: text.slice(0, IMPORT_INPUT_CHARS), truncated: text.length > IMPORT_INPUT_CHARS,
        skippedPages: Number(claimed.skipped_pages), catalog, target, now: new Date(),
      });
      const row = await this.drafts.create({
        userId, conversationId: claimed.import_conversation_id ?? undefined, featureScope: DIGITAL_EMPLOYEE_UNIFIED_SCOPE, kind: PRODUCT_IMPORT_KIND,
        payload: draft as unknown as Record<string, unknown>, preview: importPreview(draft) as unknown as Record<string, unknown>,
        question: `Save what was sorted from ${claimed.title}?`, options: ["Save", "Not now"],
      });
      await this.pool.query(
        `UPDATE marketing_product_documents SET import_status = 'ready', import_draft_id = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
        [documentId, userId, row.id]
      );
    } catch (error) {
      console.warn("[product-import] failed:", error instanceof Error ? error.name : "unknown");
      await this.pool.query(
        `UPDATE marketing_product_documents SET import_status = 'failed', import_error = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
        [documentId, userId, failureCode(error)]
      );
    }
  }

  async commit(userId: string, draftId: string, input: ImportCommitInput = {}): Promise<ProductImportResult> {
    return this.drafts.commit<ProductImportResult, ProductImportResult>(userId, draftId, PRODUCT_IMPORT_KIND, {
      applied: (draft) => ({ alreadyApplied: true, entityId: draft.appliedEntityId, managementUrl: MANAGEMENT_URL, saved: [], dropped: 0 }),
      apply: (draft) => this.apply(userId, draft, input),
    });
  }

  private async apply(userId: string, row: ConversationActionDraft, input: ImportCommitInput): Promise<ProductImportResult> {
    const draft = row.payload as unknown as ImportDraft;
    const products = applyImportEdits(draft, input);
    if (!products.length) throw new InputError("没有要保存的产品");
    const { items: catalog } = await this.materials.listProducts(userId, { page: 1, limit: CATALOG_LIMIT, status: "active" });
    const saved: ProductImportResult["saved"] = [];
    let dropped = 0;
    // Each write only adds what is missing, so a retry after a partial failure cannot duplicate.
    for (const product of products) {
      const result = await this.saveProduct(userId, product, draft.title, catalog);
      saved.push(result.saved);
      dropped += result.dropped;
    }
    if (draft.heldFromDocument) await this.discard(userId, draft.documentId);
    else await this.placeDocument(userId, draft.documentId, [...new Set(saved.map((item) => item.id))]);
    await this.drafts.markApplied(userId, row.id, saved[0].id);
    return { alreadyApplied: false, entityId: saved[0].id, managementUrl: MANAGEMENT_URL, saved, dropped };
  }

  /**
   * The save a background task may do. Model-supplied confirmations do not exist on this path, and what
   * would have waited for the owner moves to a new draft instead of being dropped with this one.
   */
  async commitUnattended(userId: string, draftId: string): Promise<UnattendedImportResult> {
    const current = await this.drafts.get(userId, draftId, PRODUCT_IMPORT_KIND);
    const draft = current.payload as unknown as ImportDraft;
    const { save, held } = splitUnattended(draft);
    const heldItems = held.reduce((sum, product) => sum + product.items.length, 0);
    if (current.status !== "applied" && !save.length) {
      const reviewUrl = importPreview(draft).reviewUrl;
      return { alreadyApplied: false, entityId: null, managementUrl: MANAGEMENT_URL, saved: [], dropped: 0, held: heldItems, reviewUrl };
    }
    return this.drafts.commit<UnattendedImportResult, UnattendedImportResult>(userId, draftId, PRODUCT_IMPORT_KIND, {
      applied: (row) => ({
        alreadyApplied: true, entityId: row.appliedEntityId, managementUrl: MANAGEMENT_URL, saved: [], dropped: 0, held: 0, reviewUrl: null,
      }),
      apply: async (row) => {
        const { items: catalog } = await this.materials.listProducts(userId, { page: 1, limit: CATALOG_LIMIT, status: "active" });
        const saved: ProductImportResult["saved"] = [];
        let dropped = 0;
        for (const product of save) {
          const result = await this.saveProduct(userId, product, draft.title, catalog);
          saved.push(result.saved);
          dropped += result.dropped;
        }
        await this.placeDocument(userId, draft.documentId, [...new Set(saved.map((item) => item.id))]);
        // Before closing the draft: a second held draft is harmless, losing these items is not.
        const reviewUrl = held.length ? await this.holdForOwner(userId, draft, held, save, saved, row.conversationId) : null;
        await this.drafts.markApplied(userId, row.id, saved[0]!.id);
        return { alreadyApplied: false, entityId: saved[0]!.id, managementUrl: MANAGEMENT_URL, saved, dropped, held: heldItems, reviewUrl };
      },
    });
  }

  /** Reviews are opened by document, so the new draft gets its own row for the same file, with no product of its own. */
  private async holdForOwner(
    userId: string, draft: ImportDraft, held: ImportProduct[], saved: ImportProduct[], results: ProductImportResult["saved"], conversationId: string | null,
  ): Promise<string> {
    const savedAs = new Map(saved.map((product, index) => [product.key, results[index]!]));
    const { rows } = await this.pool.query(
      `INSERT INTO marketing_product_documents
         (user_id, product_id, asset_id, title, mime, status, parsed_text, prompt_chars, content_hash, skipped_pages, parser_version, import_status)
       SELECT user_id, NULL, asset_id, title, mime, status, parsed_text, prompt_chars, content_hash, skipped_pages, parser_version, 'running'
       FROM marketing_product_documents WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [draft.documentId, userId]
    );
    const documentId = String(rows[0].id);
    const next: ImportDraft = {
      ...draft, documentId, heldFromDocument: draft.documentId, heldInConversation: conversationId ?? undefined,
      products: held.map((product) => {
        const target = savedAs.get(product.key);
        return target ? { ...product, name: target.name, targetProductId: target.id, targetName: target.name } : product;
      }),
    };
    const row = await this.drafts.create({
      userId, featureScope: DIGITAL_EMPLOYEE_UNIFIED_SCOPE, kind: PRODUCT_IMPORT_KIND,
      payload: next as unknown as Record<string, unknown>, preview: importPreview(next) as unknown as Record<string, unknown>,
      question: `Save what was held back from ${draft.title}?`, options: ["Save", "Not now"],
    });
    await this.pool.query(
      `UPDATE marketing_product_documents SET import_status = 'ready', import_draft_id = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
      [documentId, userId, row.id]
    );
    return importPreview(next).reviewUrl;
  }

  private async saveProduct(userId: string, product: ImportProduct, title: string, catalog: readonly MarketingProduct[]) {
    const items = product.items.filter((item) => item.selected).length;
    const sameName = !product.targetProductId
      ? catalog.find((item) => normalizedProductName(item.name) === normalizedProductName(product.name)) ?? confidentProductMatch(product.name, catalog)
      : null;
    const targetId = product.targetProductId ?? sameName?.id ?? null;
    if (!targetId) {
      const { fields } = importedFields(product, title, null);
      const created = await this.materials.createProduct(userId, parseMarketingProduct({ name: product.name, ...fields }));
      return { saved: { id: created.id, name: created.name, created: true, items }, dropped: 0 };
    }
    const current = await this.materials.getProduct(userId, targetId);
    const { fields, dropped } = importedFields(product, title, current);
    if (Object.keys(fields).length) {
      await this.materials.updateProduct(userId, targetId, parseMarketingProductUpdate({ ...fields, version: current.version }));
    }
    return { saved: { id: current.id, name: current.name, created: false, items }, dropped };
  }

  /** The first product takes the file; the others get their own row, so each can remove it alone. */
  private async placeDocument(userId: string, documentId: string, productIds: string[]): Promise<void> {
    const [first, ...rest] = productIds;
    await this.pool.query(
      `UPDATE marketing_product_documents SET product_id = $3, import_status = 'none', updated_at = now() WHERE id = $1 AND user_id = $2`,
      [documentId, userId, first]
    );
    for (const productId of rest) {
      await this.pool.query(
        `INSERT INTO marketing_product_documents
           (user_id, product_id, asset_id, title, mime, status, parsed_text, prompt_chars, content_hash, skipped_pages, parser_version)
         SELECT user_id, $3, asset_id, title, mime, status, parsed_text, prompt_chars, content_hash, skipped_pages, parser_version
         FROM marketing_product_documents WHERE id = $1 AND user_id = $2`,
        [documentId, userId, productId]
      );
    }
  }

  /**
   * Whether a task still has a file's items waiting for the owner, on this product or, with no product, at all.
   * A prompt is not enough here: a model that thinks an item looks fine would write it with the ordinary product tools.
   */
  async itemsHeldFor(userId: string, conversationId: string, productId?: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM de_conversation_action_drafts
       WHERE user_id = $1 AND kind = $2 AND status IN ('prepared', 'awaiting_confirmation') AND expires_at > now()
         AND (conversation_id::text = $3 OR payload->>'heldInConversation' = $3)
         AND ($4::jsonb IS NULL OR payload->'products' @> $4::jsonb)
       LIMIT 1`,
      [userId, PRODUCT_IMPORT_KIND, conversationId, productId ? JSON.stringify([{ targetProductId: productId }]) : null]
    );
    return rows.length > 0;
  }

  /** Saving from chat needs an owner's reply after the draft appeared: a model must not confirm for them. */
  async ownerRepliedSince(userId: string, draftId: string, conversationId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM de_conversation_action_drafts draft
       JOIN conversations conversation ON conversation.id = $3 AND conversation.user_id = draft.user_id
       JOIN messages message ON message.conversation_id = conversation.id AND message.role = 'user' AND message.created_at > draft.created_at
       WHERE draft.id = $2 AND draft.user_id = $1 LIMIT 1`,
      [userId, draftId, conversationId]
    );
    return rows.length > 0;
  }

  /** Attachments come from the stored message, never from model arguments. Newest message first. */
  async latestAttachments(userId: string, conversationId: string): Promise<Array<{ assetId: string; filename: string; kind: string }>> {
    const { rows } = await this.pool.query(
      `SELECT message.metadata->'attachments' AS attachments FROM messages message
       JOIN conversations conversation ON conversation.id = message.conversation_id
       WHERE message.conversation_id = $1 AND conversation.user_id = $2 AND message.role = 'user' AND message.metadata ? 'attachments'
       ORDER BY message.created_at DESC LIMIT 1`,
      [conversationId, userId]
    );
    return Array.isArray(rows[0]?.attachments) ? rows[0].attachments : [];
  }

  /** Lets a chat turn report the result in place. An import still running keeps going in the background. */
  async settled(userId: string, documentIds: string[], options: { timeoutMs: number; pollMs?: number; signal?: AbortSignal }): Promise<ProductImportStatus[]> {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      const statuses = await Promise.all(documentIds.map((id) => this.get(userId, id)));
      if (statuses.every((item) => item.status !== "working") || Date.now() >= deadline || options.signal?.aborted) return statuses;
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1_500));
    }
  }
}
