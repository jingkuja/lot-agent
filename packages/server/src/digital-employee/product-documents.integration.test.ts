import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SecretBox } from "../auth/secret-box.js";
import { DB } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import { PRODUCT_DOCUMENT_CHAR_LIMIT, PRODUCT_DOCUMENT_JOB } from "./product-document-service.js";
import { DigitalEmployeeService } from "./service.js";

// Explicit opt-in; never use DATABASE_URL or the application's configured database.
const testUrl = process.env.DIGITAL_EMPLOYEE_DOCS_TEST_DATABASE_URL;

describe.skipIf(!testUrl)("product documents on PostgreSQL", () => {
  let db: DB;
  let service: DigitalEmployeeService;
  const enqueue = vi.fn(async () => "task");
  const generate = vi.fn(async (_input: { context: Record<string, any> }) => ({ modelId: "m", reply: "好的" }));
  const owner = `pd-owner-${randomUUID()}`;
  const stranger = `pd-stranger-${randomUUID()}`;
  let gateway: string;
  let profileId: string;

  const asset = async (userId: string, name: string, mime = "application/pdf") => {
    const id = randomUUID();
    await db.createAsset({ id, taskId: null, userId, type: "upload", storageKey: `${id}.pdf`, url: `/static/uploads/${id}.pdf`, mime, sizeBytes: 10, originalName: name });
    return id;
  };
  const parsed = (text: string) => async () => ({ parserVersion: "v1", diagnostics: [], blocks: [{ text }] });
  const addDocument = async (name: string, text: string) => {
    const document = await service.productDocuments.add(owner, gateway, { assetId: await asset(owner, name) });
    await service.productDocuments.parse(owner, document.id, parsed(text));
    return document;
  };

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!/^\/lot_de_docs_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Requires a dedicated lot_de_docs_test_* database");
    db = new DB({
      host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: url.pathname.slice(1),
    }, new SecretBox(undefined));
    const { rows } = await db.pool.query("SELECT to_regclass('public.conversations') AS existing");
    if (rows[0].existing) throw new Error("Test database must be empty; refusing to modify existing data");
    await runMigrations(db.pool, migrations);
    service = new DigitalEmployeeService(db, new SecretBox(undefined), undefined, { enqueue } as any, { generate } as any);
    gateway = (await service.marketingMaterials.createProduct(owner, { name: "API 网关", faqs: [{ question: "问", answer: "答" }] })).id;
    profileId = (await service.createProfile(owner, { displayName: "周工" })).profile.id;
  });
  afterAll(async () => { await db?.pool.end(); });

  it("parses, lists and hands a document to the talk track", async () => {
    const document = await addDocument("费用说明.docx", "Opus 5.5 缓存写入 5.00");
    expect(enqueue).toHaveBeenCalledWith(PRODUCT_DOCUMENT_JOB, { documentId: document.id }, owner, { maxAttempts: 1 });
    const { items, usage } = await service.productDocuments.list(owner, gateway);
    expect(items[0]).toMatchObject({ title: "费用说明.docx", status: "ready", usedInTalkTrack: true });
    expect(usage.usedChars).toBeGreaterThan(0);

    await service.opportunities.generateOutreach(owner, { profileId, intent: "follow_up", channel: "wechat", message: "聊聊 api网关 的缓存" });
    const { context } = generate.mock.calls.at(-1)![0];
    expect(context.productMaterial).toMatchObject({ name: "API 网关", faqs: [{ question: "问", answer: "答" }] });
    expect(context.productDocuments).toEqual([{ product: "API 网关", title: "费用说明.docx", content: "Opus 5.5 缓存写入 5.00" }]);
  });

  it("keeps other accounts out at every step", async () => {
    const { items } = await service.productDocuments.list(owner, gateway);
    await expect(service.productDocuments.list(stranger, gateway)).rejects.toThrow("未找到该产品资料");
    await expect(service.productDocuments.add(stranger, gateway, { assetId: await asset(stranger, "x.pdf") })).rejects.toThrow("未找到该产品资料");
    await expect(service.productDocuments.add(owner, gateway, { assetId: await asset(stranger, "x.pdf") })).rejects.toThrow("未找到上传的文件");
    await expect(service.productDocuments.remove(stranger, gateway, items[0].id)).rejects.toThrow("未找到这份资料");
    await expect(service.productDocuments.retry(stranger, gateway, items[0].id)).rejects.toThrow();
    expect(await service.productDocuments.forPrompt(stranger, [{ id: gateway, name: "API 网关" }], 15_000)).toEqual([]);
    await service.productDocuments.parse(stranger, items[0].id, parsed("篡改"));
    expect((await service.productDocuments.read(owner, gateway)).document?.text).toContain("Opus");
  });

  it("marks a long document as unused but still lets the conversation read it", async () => {
    const long = await addDocument("长手册.pdf", "长".repeat(PRODUCT_DOCUMENT_CHAR_LIMIT + 100));
    const { items } = await service.productDocuments.list(owner, gateway);
    expect(items.find((item) => item.id === long.id)).toMatchObject({ status: "ready", usedInTalkTrack: false });
    const page = await service.productDocuments.read(owner, gateway, { documentId: long.id });
    expect(page.document?.nextOffset).toBe(12_000);
  });

  it("retries a failed parse, and removing a document clears its text", async () => {
    const document = await service.productDocuments.add(owner, gateway, { assetId: await asset(owner, "扫描件.pdf") });
    await service.productDocuments.parse(owner, document.id, async () => { throw new Error("OCR_REQUIRED"); });
    const failed = (await service.productDocuments.list(owner, gateway)).items.find((item) => item.id === document.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "OCR_REQUIRED" });

    await expect(service.productDocuments.retry(owner, gateway, document.id)).resolves.toMatchObject({ status: "pending", errorCode: null });
    await service.productDocuments.parse(owner, document.id, parsed("补读成功"));
    await service.productDocuments.remove(owner, gateway, document.id);
    const { rows } = await db.pool.query("SELECT parsed_text, deleted_at FROM marketing_product_documents WHERE id = $1", [document.id]);
    expect(rows[0].parsed_text).toBeNull();
    expect(rows[0].deleted_at).not.toBeNull();
    await service.productDocuments.parse(owner, document.id, parsed("迟到的解析"));
    expect((await db.pool.query("SELECT parsed_text FROM marketing_product_documents WHERE id = $1", [document.id])).rows[0].parsed_text).toBeNull();
  });

  it("reports a file that has gone missing and stops using an archived product", async () => {
    const document = await service.productDocuments.add(owner, gateway, { assetId: await asset(owner, "丢失.pdf") });
    await db.pool.query("UPDATE marketing_product_documents SET asset_id = NULL WHERE id = $1", [document.id]);
    await service.productDocuments.parse(owner, document.id, parsed("x"));
    const lost = (await service.productDocuments.list(owner, gateway)).items.find((item) => item.id === document.id);
    expect(lost).toMatchObject({ status: "failed", errorCode: "SOURCE_MISSING" });

    const product = await service.marketingMaterials.getProduct(owner, gateway);
    await service.marketingMaterials.archiveProduct(owner, gateway, product.version);
    await expect(service.productDocuments.list(owner, gateway)).rejects.toThrow("未找到该产品资料");
    generate.mockClear();
    await service.opportunities.generateOutreach(owner, { profileId, intent: "follow_up", channel: "wechat", message: "聊聊 API 网关" });
    expect(generate.mock.calls[0][0].context.productDocuments).toBeUndefined();
  });
});
