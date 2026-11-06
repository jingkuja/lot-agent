import { describe, expect, it, vi } from "vitest";
import { createMarketingMaterialTools } from "./marketing-material-tools.js";
import { ToolRegistry } from "@lot-agent/core";

function tool(name: string, service: Record<string, unknown>, documents?: Record<string, unknown>) {
  return createMarketingMaterialTools(service as any, documents as any).find((item) => item.name === name)!;
}

describe("marketing material agent tools", () => {
  it("preserves an ambiguous committed write through the business error wrapper", async () => {
    const createProduct = vi.fn(async () => { throw new Error("ECONNRESET after commit"); });
    const registry = new ToolRegistry();
    registry.register(tool("create_marketing_product", { createProduct }));
    const result = await registry.execute("create_marketing_product", { name: "Product" }, { userId: "u1", workingDirectory: "/tmp" });
    expect(result.errorKind).toBe("unknown_outcome");
    expect(createProduct).toHaveBeenCalledOnce();
  });

  it("finds a product when the search words do not appear in it literally", async () => {
    const listProducts = vi.fn(async (_userId: string, filters: { query?: string }) => (filters.query
      ? { items: [], page: 1, limit: 20, total: 0 }
      : { items: [{ id: "p1", name: "机房运维服务" }, { id: "p2", name: "API 网关" }], page: 1, limit: 100, total: 2 }));
    const result = await tool("search_marketing_materials", { listProducts, getBrandAssets: vi.fn(async () => null) }, {
      summaries: vi.fn(async () => new Map([["p2", [{ id: "d1", title: "费用说明", status: "ready" }]]])),
    }).execute({ query: "API网关" }, { userId: "u1", workingDirectory: "/tmp" });
    expect(JSON.parse(result.content)).toMatchObject({
      total: 1, items: [{ id: "p2", supplementDocuments: [{ title: "费用说明" }] }],
    });
  });

  it("lists every product when a search matches none, and says so", async () => {
    const listProducts = vi.fn(async (_userId: string, filters: { query?: string }) => (filters.query
      ? { items: [], page: 1, limit: 20, total: 0 }
      : { items: [{ id: "p1", name: "API 网关" }], page: 1, limit: 100, total: 1 }));
    const result = await tool("search_marketing_materials", { listProducts, getBrandAssets: vi.fn(async () => null) })
      .execute({ query: "Opus 5.5" }, { userId: "u1", workingDirectory: "/tmp" });
    expect(JSON.parse(result.content)).toMatchObject({ queryMatched: false, items: [{ id: "p1" }] });
  });

  describe("product file import", () => {
    const importTool = (name: string, imports: Record<string, unknown>, documents: Record<string, unknown> = {}) =>
      createMarketingMaterialTools({} as any, documents as any, imports as any).find((item) => item.name === name)!;
    const context = { userId: "u1", conversationId: "c1", workingDirectory: "/tmp" };
    const ready = { id: "d1", title: "手册.docx", status: "ready", errorCode: null, draftId: "dr1", preview: { reviewUrl: "/digital-employee/materials/import/d1" } };
    const draft = {
      truncated: false, skippedPages: 0,
      products: [{
        name: "", suggestedName: "小店", targetName: null, positioning: "",
        items: [{ id: "p1-1", text: "198 元", selected: true }, { id: "p1-2", text: "新客 99 元", selected: false, flag: "benefit" }, { id: "p1-3", text: "A3 1299 元", selected: true, flag: "image" }],
        questions: [{ id: "p1-name", field: "name", question: "" }],
      }],
    };

    it("reads the attachment from the stored message and reports what needs the owner", async () => {
      const start = vi.fn(async () => ready);
      const result = await importTool("import_product_file", {
        latestAttachments: vi.fn(async () => [{ assetId: "a1", kind: "doc" }, { assetId: "a2", kind: "image" }]),
        start, settled: vi.fn(async () => [ready, ready]), review: vi.fn(async () => ({ draft })),
      }).execute({}, context);
      expect(start).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledWith("u1", { assetId: "a2", conversationId: "c1" });
      expect(JSON.parse(result.content).imports[0]).toMatchObject({
        draftId: "dr1",
        products: [{
          savedAsIfUnnamed: "小店", fromFile: ["198 元", "A3 1299 元"], readFromPictures: 1,
          needsOwner: [{ id: "p1-2", reason: "benefit" }], questions: [{ id: "p1-name", question: "What is this product called?" }],
        }],
      });
    });

    it("starts nothing when no file was sent", async () => {
      const start = vi.fn();
      const result = await importTool("import_product_file", { latestAttachments: vi.fn(async () => []), start }).execute({}, context);
      expect(JSON.parse(result.content).imports).toEqual([]);
      expect(start).not.toHaveBeenCalled();
    });

    it("attaches to the product the owner named, however loosely", async () => {
      const start = vi.fn(async () => ready);
      await importTool("import_product_file", {
        latestAttachments: vi.fn(async () => [{ assetId: "a1", kind: "doc" }]), start, settled: vi.fn(async () => [ready]), review: vi.fn(async () => ({ draft })),
      }, { resolveProduct: vi.fn(async () => ({ product: { id: "11111111-1111-4111-8111-111111111111", name: "API 网关" }, candidates: [] })) })
        .execute({ product: "网关" }, context);
      expect(start).toHaveBeenCalledWith("u1", expect.objectContaining({ productId: "11111111-1111-4111-8111-111111111111" }));
    });

    it("refuses to save until the owner has replied", async () => {
      const commit = vi.fn();
      const draftId = "22222222-2222-4222-8222-222222222222";
      const replied = vi.fn(async () => false);
      const result = await importTool("commit_product_import", { commit, ownerRepliedSince: replied }).execute({ draftId }, context);
      expect(result).toMatchObject({ isError: true });
      expect(replied).toHaveBeenCalledWith("u1", draftId, "c1");
      expect(commit).not.toHaveBeenCalled();
    });

    it("commits answers and approvals by id", async () => {
      const commit = vi.fn(async () => ({ alreadyApplied: false, saved: [{ name: "小店" }] }));
      const draftId = "22222222-2222-4222-8222-222222222222";
      await importTool("commit_product_import", { commit, ownerRepliedSince: vi.fn(async () => true) }).execute({
        draftId, answers: [{ id: "p1-name", answer: "小店" }], confirmItemIds: ["p1-2"],
      }, context);
      expect(commit).toHaveBeenCalledWith("u1", draftId, { answers: [{ id: "p1-name", answer: "小店" }], confirmItemIds: ["p1-2"] });
    });
  });

  describe("read_product_documents", () => {
    const context = { userId: "u1", workingDirectory: "/tmp" };

    it("reads the product the user loosely named", async () => {
      const documents = {
        resolveProduct: vi.fn(async () => ({ product: { id: "p1", name: "API 网关" }, candidates: [] })),
        read: vi.fn(async () => ({ documents: [], document: { id: "d1", title: "说明", text: "正文", nextOffset: null } })),
      };
      const result = await tool("read_product_documents", {}, documents).execute({ product: "网关" }, context);
      expect(documents.resolveProduct).toHaveBeenCalledWith("u1", "网关");
      expect(documents.read).toHaveBeenCalledWith("u1", "p1", { documentId: undefined, offset: undefined });
      expect(JSON.parse(result.content)).toMatchObject({ product: { name: "API 网关" }, document: { text: "正文" } });
    });

    it("hands back the choices when several products fit", async () => {
      const documents = {
        resolveProduct: vi.fn(async () => ({ product: null, candidates: [{ id: "a", name: "API 网关" }, { id: "b", name: "AI 网关" }] })),
        read: vi.fn(),
      };
      const result = await tool("read_product_documents", {}, documents).execute({ product: "网关" }, context);
      expect(JSON.parse(result.content)).toMatchObject({ product: null, candidates: ["API 网关", "AI 网关"] });
      expect(documents.read).not.toHaveBeenCalled();
    });

    it("is allowed in every chat that can see products", () => {
      const definition = tool("read_product_documents", {}, {});
      expect(definition.parameters.required).toEqual(["product"]);
    });
  });

  it("returns products and brand facts from the user-scoped store", async () => {
    const service = {
      listProducts: vi.fn(async () => ({ items: [{ id: "p1", name: "会员版" }], page: 1, limit: 20, total: 1 })),
      getBrandAssets: vi.fn(async () => ({ tone: ["专业"] })),
    };
    const result = await tool("search_marketing_materials", service).execute(
      { query: "会员", includeBrand: true },
      { userId: "u1", workingDirectory: "/tmp" }
    );
    expect(service.listProducts).toHaveBeenCalledWith("u1", expect.objectContaining({ query: "会员" }));
    expect(JSON.parse(result.content)).toMatchObject({ total: 1, brandAssets: { tone: ["专业"] } });
  });

  it("uses the latest server version when updating a product", async () => {
    const service = {
      getProduct: vi.fn(async () => ({ id: "00000000-0000-0000-0000-000000000001", name: "旧名称", version: 4 })),
      updateProduct: vi.fn(async (_userId, _id, input) => ({ name: input.name, version: 5 })),
    };
    const result = await tool("update_marketing_product", service).execute(
      { productId: "00000000-0000-0000-0000-000000000001", name: "新名称" },
      { userId: "u1", workingDirectory: "/tmp" }
    );
    expect(service.updateProduct).toHaveBeenCalledWith(
      "u1",
      "00000000-0000-0000-0000-000000000001",
      expect.objectContaining({ name: "新名称", version: 4 })
    );
    expect(result.content).toContain("新名称");
  });
});
