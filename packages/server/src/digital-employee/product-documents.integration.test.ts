import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SecretBox } from "../auth/secret-box.js";
import { DB } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import { DIGITAL_EMPLOYEE_LLM_UNAVAILABLE } from "./llm.js";
import { PRODUCT_DOCUMENT_CHAR_LIMIT, PRODUCT_DOCUMENT_JOB, type ProductDocumentParser } from "./product-document-service.js";
import type { ImportModelProduct } from "./product-import.js";
import { ProposalService } from "./proposal-service.js";
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
  const proposals = () => new ProposalService(db.pool, {} as any, {} as any);
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

  describe("importing a file", () => {
    const manual = "小气泡清洁单次 198 元，60 分钟。新客体验价 99 元。预约电话 13812345678。";
    const entry = (over: Partial<ImportModelProduct> = {}): ImportModelProduct => ({
      name: "焕颜美学", suggestedName: "", existing: "", positioning: "皮肤管理", coreValues: ["科技护肤"],
      facts: [{ statement: "小气泡清洁单次 198 元" }, { statement: "预约电话 13812345678" }, { statement: "光子嫩肤 1280 元" }],
      benefits: [{ title: "新客体验价 99 元" }], objections: [], faqs: [], prohibited: [], cases: [],
      notes: "", questions: [{ field: "notes", question: "优惠到什么时候？" }],
      ...over,
    });
    const started = async (name: string, text: string, input: { productId?: string } = {}) => {
      const status = await service.productImports.start(importer, { assetId: await asset(importer, name), ...input });
      await service.productDocuments.parse(importer, status.id, parsed(text));
      return status;
    };
    const importer = `pd-importer-${randomUUID()}`;

    it("holds everything back until the owner saves, then adds only what was approved", async () => {
      const generate = vi.fn(async () => [entry()]);
      const { id } = await started("手册.md", manual);
      await service.productImports.run(importer, id, generate);
      await service.productImports.run(importer, id, generate);
      expect(generate).toHaveBeenCalledOnce();
      expect((await service.marketingMaterials.listProducts(importer, { page: 1, limit: 10 })).total).toBe(0);

      const { status, draft } = await service.productImports.review(importer, id);
      expect(status).toMatchObject({ status: "ready", preview: { needsReview: 3, questions: 1 } });
      const items = draft!.products[0].items;
      expect(items.find((item) => item.text.includes("光子"))).toMatchObject({ selected: false, flag: "number" });
      expect(items.find((item) => item.text.includes("电话"))).toMatchObject({ selected: false, flag: "contact" });
      expect(items.find((item) => item.field === "currentBenefits")).toMatchObject({ selected: false, flag: "benefit" });

      const today = await proposals().listPending(importer);
      expect(today).toMatchObject([{ kind: "product_import", confirmable: false, preview: { reviewUrl: `/digital-employee/materials/import/${id}` } }]);
      await expect(proposals().confirm(importer, status.draftId!)).rejects.toThrow("这项需要先在对话里选择");

      const question = draft!.products[0].questions[0];
      const benefit = items.find((item) => item.field === "currentBenefits")!;
      const result = await service.productImports.commit(importer, status.draftId!, {
        confirmItemIds: [benefit.id], answers: [{ id: question.id, answer: "年底" }],
      });
      expect(result).toMatchObject({ alreadyApplied: false, saved: [{ name: "焕颜美学", created: true }] });
      const product = await service.marketingMaterials.getProduct(importer, result.entityId!);
      expect(product.verifiableFacts).toEqual([{ statement: "小气泡清洁单次 198 元", evidence: "手册.md" }]);
      expect(product.currentBenefits[0]).toMatchObject({ title: "新客体验价 99 元" });
      expect(product.productNotes).toContain("优惠到什么时候？ 年底");
      expect(await service.productDocuments.list(importer, product.id)).toMatchObject({ items: [{ id, status: "ready" }] });
      expect(await service.productImports.list(importer)).toEqual([]);

      const again = await service.productImports.commit(importer, status.draftId!);
      expect(again).toMatchObject({ alreadyApplied: true, entityId: product.id });
      expect((await service.marketingMaterials.getProduct(importer, product.id)).version).toBe(product.version);
    });

    it("adds to a product already on file without touching its positioning, and keeps edits made meanwhile", async () => {
      const shop = await service.marketingMaterials.createProduct(importer, {
        name: "老街牛肉面", positioning: "社区面馆", coreValues: ["现炖"], verifiableFacts: [{ statement: "周一休息" }],
      });
      const { id } = await started("价目表.txt", "老街牛肉面 红烧 18 周一休息");
      await service.productImports.run(importer, id, async () => [entry({
        name: "老街牛面", existing: "老街牛肉面", positioning: "改掉定位", coreValues: ["改掉卖点"],
        facts: [{ statement: "红烧 18" }, { statement: "周一休息" }], benefits: [], questions: [],
      })]);
      const { status, draft } = await service.productImports.review(importer, id);
      expect(draft!.products[0]).toMatchObject({ targetProductId: shop.id, positioning: "" });
      expect(draft!.products[0].items.map((item) => item.text)).toEqual(["红烧 18"]);

      await service.marketingMaterials.updateProduct(importer, shop.id, { version: shop.version, productNotes: "老板刚改的" });
      await service.productImports.commit(importer, status.draftId!);
      const saved = await service.marketingMaterials.getProduct(importer, shop.id);
      expect(saved).toMatchObject({ positioning: "社区面馆", coreValues: ["现炖"], productNotes: "老板刚改的" });
      expect(saved.verifiableFacts.map((item) => item.statement)).toEqual(["周一休息", "红烧 18"]);
    });

    it("saves a file that never named its product under a working name the owner can replace", async () => {
      const nameless = entry({
        name: "", suggestedName: "上门修手机", positioning: "", coreValues: [], facts: [{ statement: "一次二三十块钱" }], benefits: [], questions: [],
      });
      const first = await started("想法.txt", "上门修手机 一次二三十块钱");
      await service.productImports.run(importer, first.id, async () => [nameless]);
      const skipped = await service.productImports.review(importer, first.id);
      expect(skipped.draft!.products[0].questions[0]).toMatchObject({ field: "name" });
      expect((await service.productImports.commit(importer, skipped.status.draftId!)).saved).toMatchObject([{ name: "上门修手机", created: true }]);

      const second = await started("另一个.txt", "教老人用微信 一次二三十块钱");
      await service.productImports.run(importer, second.id, async () => [{ ...nameless, suggestedName: "教微信", facts: [{ statement: "教老人用微信" }] }]);
      const answered = await service.productImports.review(importer, second.id);
      const question = answered.draft!.products[0].questions[0];
      const result = await service.productImports.commit(importer, answered.status.draftId!, { answers: [{ id: question.id, answer: "社区手机帮" }] });
      expect(result.saved).toMatchObject([{ name: "社区手机帮", created: true }]);
    });

    it("gives every product its own copy of a shared file", async () => {
      const { id } = await started("简章.txt", "利润班 6800 元 短视频班 1980 元");
      await service.productImports.run(importer, id, async () => [
        entry({ name: "利润班", positioning: "", coreValues: [], facts: [{ statement: "利润班 6800 元" }], benefits: [], questions: [] }),
        entry({ name: "短视频班", positioning: "", coreValues: [], facts: [{ statement: "短视频班 1980 元" }], benefits: [], questions: [] }),
      ]);
      const { status } = await service.productImports.review(importer, id);
      const { saved } = await service.productImports.commit(importer, status.draftId!);
      const lists = await Promise.all(saved.map((item) => service.productDocuments.list(importer, item.id)));
      expect(lists.map((list) => list.items.length)).toEqual([1, 1]);
      expect(lists[1].items[0].id).not.toBe(id);
    });

    it("reads a resent file once, retries a failed read only when asked, and forgets a discarded one", async () => {
      const assetId = await asset(importer, "重复.txt");
      const first = await service.productImports.start(importer, { assetId });
      expect((await service.productImports.start(importer, { assetId })).id).toBe(first.id);
      await service.productDocuments.parse(importer, first.id, parsed("文字"));

      await service.productImports.run(importer, first.id, async () => { throw new Error("gateway down"); });
      expect(await service.productImports.get(importer, first.id)).toMatchObject({ status: "failed", errorCode: "MODEL_FAILED" });
      await service.productImports.run(importer, first.id, async () => { throw new Error("must not run"); });
      await service.productImports.retry(importer, first.id);
      await service.productImports.run(importer, first.id, async () => { throw new Error(DIGITAL_EMPLOYEE_LLM_UNAVAILABLE); });
      expect(await service.productImports.get(importer, first.id)).toMatchObject({ status: "failed", errorCode: "MODEL_UNAVAILABLE" });
      await service.productImports.retry(importer, first.id);
      await service.productImports.run(importer, first.id, async () => [entry({ facts: [], benefits: [], coreValues: [], questions: [] })]);
      const { status } = await service.productImports.review(importer, first.id);
      expect(status.status).toBe("ready");

      await proposals().dismiss(importer, status.draftId!);
      const { rows } = await db.pool.query("SELECT parsed_text, deleted_at FROM marketing_product_documents WHERE id = $1", [first.id]);
      expect(rows[0].parsed_text).toBeNull();
      expect(rows[0].deleted_at).not.toBeNull();
    });

    it("knows whether the owner has spoken since a draft appeared", async () => {
      const { id } = await started("等回复.txt", "内容");
      const conversationId = randomUUID();
      await db.pool.query("INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 't')", [conversationId, importer]);
      await db.addMessage(randomUUID(), conversationId, "user", "发文件");
      await service.productImports.run(importer, id, async () => [entry({ facts: [], benefits: [], coreValues: [], questions: [] })]);
      const { status } = await service.productImports.review(importer, id);
      expect(await service.productImports.ownerRepliedSince(importer, status.draftId!, conversationId)).toBe(false);

      await db.addMessage(randomUUID(), conversationId, "assistant", "存吗");
      expect(await service.productImports.ownerRepliedSince(importer, status.draftId!, conversationId)).toBe(false);
      await db.addMessage(randomUUID(), conversationId, "user", "存吧");
      expect(await service.productImports.ownerRepliedSince(importer, status.draftId!, conversationId)).toBe(true);
      expect(await service.productImports.ownerRepliedSince(stranger, status.draftId!, conversationId)).toBe(false);
    });

    it("carries a parsing failure through to the import", async () => {
      const status = await service.productImports.start(importer, { assetId: await asset(importer, "扫描.pdf") });
      await service.productDocuments.parse(importer, status.id, async () => { throw new Error("OCR_REQUIRED"); });
      await service.productImports.run(importer, status.id, async () => { throw new Error("must not run"); });
      expect(await service.productImports.get(importer, status.id)).toMatchObject({ status: "failed", errorCode: "OCR_REQUIRED" });
    });

    it("keeps one owner's imports from another", async () => {
      const { id } = await started("私有.txt", "内容");
      await expect(service.productImports.get(stranger, id)).rejects.toThrow("未找到这次导入");
      await expect(service.productImports.start(stranger, { assetId: await asset(importer, "别人的.txt") })).rejects.toThrow("未找到上传的文件");
      await service.productImports.run(importer, id, async () => [entry({ facts: [], benefits: [], coreValues: [], questions: [] })]);
      const { status } = await service.productImports.review(importer, id);
      await expect(service.productImports.commit(stranger, status.draftId!)).rejects.toThrow("未找到待确认草稿");
      await expect(service.productImports.commit(importer, status.draftId!, {
        products: [{ key: "p1", targetProductId: gateway }],
      })).rejects.toThrow("未找到该产品资料");
    });
  });

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

  it("pays for each picture once, even when a read fails partway through", async () => {
    const document = await service.productDocuments.add(owner, gateway, { assetId: await asset(owner, "扫描.png", "image/png") });
    const reads: string[] = [];
    const parser = (failOn?: string): ProductDocumentParser => async (_file, _signal, remember) => {
      const blocks = [];
      for (const page of [1, 2]) {
        const text = await remember!({ bytes: new Uint8Array([page]), page }, async () => {
          reads.push(`第 ${page} 页`);
          if (failOn === `第 ${page} 页`) throw new Error("OCR_RATE_LIMITED");
          return `第 ${page} 页文字`;
        });
        blocks.push({ text, origin: "ocr", citation: { kind: "pdf", page } });
      }
      return { parserVersion: "v1", diagnostics: [], blocks };
    };
    await service.productDocuments.parse(owner, document.id, parser("第 2 页"));
    const saved = await db.pool.query("SELECT ocr_pages FROM marketing_product_documents WHERE id = $1", [document.id]);
    expect(Object.keys(saved.rows[0].ocr_pages)).toHaveLength(1);

    await service.productDocuments.retry(owner, gateway, document.id);
    await service.productDocuments.parse(owner, document.id, parser());
    expect(reads).toEqual(["第 1 页", "第 2 页", "第 2 页"]);
    const { rows } = await db.pool.query("SELECT status, parsed_text, ocr_pages FROM marketing_product_documents WHERE id = $1", [document.id]);
    expect(rows[0]).toMatchObject({ status: "ready", ocr_pages: {} });
    expect(rows[0].parsed_text).toContain("[Page 1]\n[Image text]\n第 1 页文字\n[/Image text]");
    await service.productDocuments.remove(owner, gateway, document.id);
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
