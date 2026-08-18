import { describe, expect, it, vi } from "vitest";
import { createMarketingMaterialTools } from "./marketing-material-tools.js";

function tool(name: string, service: Record<string, unknown>) {
  return createMarketingMaterialTools(service as any).find((item) => item.name === name)!;
}

describe("marketing material agent tools", () => {
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
