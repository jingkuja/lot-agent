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
