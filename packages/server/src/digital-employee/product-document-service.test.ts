import { describe, expect, it, vi } from "vitest";
import { documentText, fitDocuments, PRODUCT_DOCUMENT_JOB, ProductDocumentService } from "./product-document-service.js";

const PRODUCT = "00000000-0000-4000-8000-000000000001";
const ASSET = "00000000-0000-4000-8000-000000000002";
const DOCUMENT = "00000000-0000-4000-8000-000000000003";

function row(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return { id: DOCUMENT, product_id: PRODUCT, title: "手册", mime: "application/pdf", status: "ready", error_code: null, prompt_chars: 100,
    content_hash: "h1", skipped_pages: 0, created_at: now, updated_at: now, ...overrides };
}

describe("documentText", () => {
  it("marks PDF pages and counts pages it could not read", () => {
    const result = documentText({
      parserVersion: "v1", diagnostics: ["OCR_REQUIRED_PAGE_2"],
      blocks: [
        { text: "第一页", citation: { kind: "pdf", page: 1 } },
        { text: "第三页", citation: { kind: "pdf", page: 3 } },
      ],
    });
    expect(result).toEqual({ text: "[Page 1]\n第一页\n[Page 3]\n第三页", skippedPages: 1 });
  });
});

describe("fitDocuments", () => {
  it("keeps whole documents, skips what does not fit and counts duplicates once", () => {
    const documents = [
      { id: "a", chars: 9_000, hash: "same" },
      { id: "b", chars: 9_000, hash: "same" },
      { id: "c", chars: 8_000, hash: "other" },
      { id: "d", chars: 5_000, hash: "third" },
    ];
    expect(fitDocuments(documents, 15_000).map((item) => item.id)).toEqual(["a", "d"]);
  });
});

describe("ProductDocumentService", () => {
  function setup(handler: (sql: string, params: any[]) => { rows: any[]; rowCount?: number } | undefined, queue?: any) {
    const query = vi.fn(async (sql: string, params: any[] = []) => handler(sql, params) ?? { rows: [], rowCount: 0 });
    return { query, service: new ProductDocumentService({ query } as any, queue) };
  }
  const product = (sql: string) => sql.includes("FROM marketing_products") ? { rows: [{ id: PRODUCT, name: "API 网关" }] } : undefined;

  it("refuses a product or file that belongs to someone else", async () => {
    const noProduct = setup(() => undefined);
    await expect(noProduct.service.list("u1", PRODUCT)).rejects.toThrow("未找到该产品资料");
    const noAsset = setup((sql) => product(sql));
    await expect(noAsset.service.add("u1", PRODUCT, { assetId: ASSET })).rejects.toThrow("未找到上传的文件");
    expect(noAsset.query.mock.calls.some(([sql, params]) => sql.includes("FROM assets") && params![1] === "u1")).toBe(true);
  });

  it("refuses audio and video with a plain reason", async () => {
    const { service } = setup((sql) => product(sql) ?? (sql.includes("FROM assets")
      ? { rows: [{ id: ASSET, mime: "video/mp4", original_name: "a.png", storage_key: "a.png" }] } : undefined));
    await expect(service.add("u1", PRODUCT, { assetId: ASSET })).rejects.toThrow("暂时读不了");
  });

  it("queues a new document and reports a failed queue instead of leaving it pending", async () => {
    const asset = { rows: [{ id: ASSET, mime: "application/pdf", original_name: "手册.pdf", storage_key: "a.pdf" }] };
    const handler = (sql: string) => product(sql) ?? (sql.includes("FROM assets") ? asset
      : sql.includes("INSERT INTO marketing_product_documents") ? { rows: [row({ status: "pending" })] } : undefined);
    const enqueue = vi.fn(async () => "task");
    const ok = setup(handler, { enqueue });
    await expect(ok.service.add("u1", PRODUCT, { assetId: ASSET })).resolves.toMatchObject({ status: "pending" });
    expect(enqueue).toHaveBeenCalledWith(PRODUCT_DOCUMENT_JOB, { documentId: DOCUMENT }, "u1", { maxAttempts: 1 });

    const down = setup(handler, { enqueue: vi.fn(async () => { throw new Error("redis"); }) });
    await expect(down.service.add("u1", PRODUCT, { assetId: ASSET })).resolves.toMatchObject({ status: "failed", errorCode: "QUEUE_UNAVAILABLE" });
  });

  it("shows which documents fit and treats a stuck parse as failed", async () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const rows = [
      row({ id: "a", prompt_chars: 14_000, content_hash: "1" }),
      row({ id: "b", prompt_chars: 2_000, content_hash: "2" }),
      row({ id: "c", status: "processing", updated_at: old }),
    ];
    const { service } = setup((sql) => product(sql) ?? (sql.includes("FROM marketing_product_documents") ? { rows } : undefined));
    const result = await service.list("u1", PRODUCT);
    expect(result.items.map((item) => [item.id, item.usedInTalkTrack, item.status])).toEqual([
      ["a", true, "ready"], ["b", false, "ready"], ["c", false, "failed"],
    ]);
    expect(result.items[2].errorCode).toBe("PARSE_STALLED");
    expect(result.usage).toEqual({ usedChars: 14_000, limitChars: 15_000 });
  });

  it("stores parsed text and keeps a parser error code, never its message", async () => {
    const claim = (sql: string) => sql.includes("FROM (SELECT id, storage_key FROM assets)")
      ? { rows: [{ mime: "application/pdf", storage_key: "a.pdf" }] } : undefined;
    const ok = setup(claim);
    await ok.service.parse("u1", DOCUMENT, async () => ({ parserVersion: "v1", diagnostics: [], blocks: [{ text: "内容" }] }));
    const saved = ok.query.mock.calls.find(([sql]) => sql.includes("status = 'ready'"))!;
    expect(saved[1]).toEqual(expect.arrayContaining([DOCUMENT, "u1", "内容", JSON.stringify("内容").length]));

    const failed = setup(claim);
    await failed.service.parse("u1", DOCUMENT, async () => { throw new Error("OCR_REQUIRED"); });
    expect(failed.query.mock.calls.at(-1)![1]).toEqual([DOCUMENT, "u1", "OCR_REQUIRED"]);
    const leaked = setup(claim);
    await leaked.service.parse("u1", DOCUMENT, async () => { throw new Error("secret file contents"); });
    expect(leaked.query.mock.calls.at(-1)![1]).toEqual([DOCUMENT, "u1", "PARSE_FAILED"]);
  });

  it("resolves loose names and asks when several fit", async () => {
    const { service } = setup((sql) => sql.includes("FROM marketing_products")
      ? { rows: [{ id: "g", name: "API 网关" }, { id: "h", name: "AI 网关" }, { id: "m", name: "机房运维" }] } : undefined);
    expect((await service.resolveProduct("u1", "API网关")).product?.id).toBe("g");
    const tied = await service.resolveProduct("u1", "网关");
    expect(tied.product).toBeNull();
    expect(tied.candidates.map((item) => item.id)).toEqual(["g", "h"]);
  });

  it("reads a long document one page at a time", async () => {
    const text = "字".repeat(13_000);
    const { service } = setup((sql) => product(sql)
      ?? (sql.includes("SELECT parsed_text") ? { rows: [{ parsed_text: text }] }
        : sql.includes("FROM marketing_product_documents") ? { rows: [row()] } : undefined));
    const first = await service.read("u1", PRODUCT);
    expect(first.document?.text).toHaveLength(12_000);
    expect(first.document?.nextOffset).toBe(12_000);
    const second = await service.read("u1", PRODUCT, { offset: 12_000 });
    expect(second.document?.text).toHaveLength(1_000);
    expect(second.document?.nextOffset).toBeNull();
  });
});
