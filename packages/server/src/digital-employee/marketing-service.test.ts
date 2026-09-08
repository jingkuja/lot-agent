import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "./errors.js";
import { MarketingMaterialsService } from "./marketing-service.js";

const now = new Date("2026-08-20T10:00:00.000Z").toISOString();

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    user_id: "u1",
    name: "会员版",
    positioning: "一体化会员经营",
    core_values: ["省心"],
    verifiable_facts: [{ statement: "支持7天无理由退订", evidence: "官网公告" }],
    common_objections: [],
    current_benefits: [],
    prohibited_expressions: [],
    case_materials: [],
    status: "active",
    version: 3,
    archived_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function brandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    user_id: "u1",
    tone: ["专业克制"],
    visual_assets: [],
    standard_calls_to_action: ["预约咨询"],
    version: 2,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function serviceWith(query: ReturnType<typeof vi.fn>) {
  return new MarketingMaterialsService({ pool: { query } } as any);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("MarketingMaterialsService products", () => {
  it("查询不到产品时抛出NotFoundError", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(serviceWith(query).getProduct("u1", "missing")).rejects.toThrow(NotFoundError);
  });

  it("创建产品时生成新ID并按用户落库", async () => {
    const query = vi.fn(async () => ({ rows: [productRow()] }));
    const product = await serviceWith(query).createProduct("u1", { name: "会员版" });
    expect(product.name).toBe("会员版");
    expect(product.verifiableFacts).toEqual([{ statement: "支持7天无理由退订", evidence: "官网公告" }]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO marketing_products");
    expect(params[0]).toMatch(UUID_PATTERN);
    expect(params[1]).toBe("u1");
  });

  it("同名有效产品触发唯一约束时映射为ConflictError", async () => {
    const query = vi.fn(async () => Promise.reject(Object.assign(new Error("dup"), { code: "23505" })));
    await expect(serviceWith(query).createProduct("u1", { name: "会员版" })).rejects.toThrow("已有同名的有效产品资料");
  });

  it("更新命中时返回递增版本的产品", async () => {
    const query = vi.fn(async () => ({ rows: [productRow({ version: 4 })] }));
    const product = await serviceWith(query).updateProduct("u1", "00000000-0000-0000-0000-000000000001", { positioning: "新定位", version: 3 });
    expect(product.version).toBe(4);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("版本不匹配且产品仍有效时抛出ConflictError", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [productRow()] });
    await expect(serviceWith(query).updateProduct("u1", "00000000-0000-0000-0000-000000000001", { positioning: "新定位", version: 1 }))
      .rejects.toThrow(ConflictError);
  });

  it("已归档产品不可修改", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [productRow({ status: "archived", archived_at: now })] });
    await expect(serviceWith(query).updateProduct("u1", "00000000-0000-0000-0000-000000000001", { positioning: "新定位", version: 3 }))
      .rejects.toThrow("已归档的产品不能修改");
  });

  it("归档产品区分版本冲突与记录缺失", async () => {
    const conflict = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [productRow()] });
    await expect(serviceWith(conflict).archiveProduct("u1", "00000000-0000-0000-0000-000000000001", 1)).rejects.toThrow(ConflictError);

    const missing = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(serviceWith(missing).archiveProduct("u1", "missing", 1)).rejects.toThrow(NotFoundError);

    const archived = vi.fn(async () => ({ rows: [productRow({ status: "archived", version: 4, archived_at: now })] }));
    const result = await serviceWith(archived).archiveProduct("u1", "00000000-0000-0000-0000-000000000001", 3);
    expect(result.status).toBe("archived");
    expect(result.archivedAt).toBe(now);
  });
});

describe("MarketingMaterialsService brand assets", () => {
  it("首次保存走创建路径", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [brandRow({ version: 1 })] });
    const brand = await serviceWith(query).saveBrandAssets("u1", { tone: ["专业克制"] });
    expect(brand.version).toBe(1);
    expect(query.mock.calls[1][0]).toContain("INSERT INTO marketing_brand_assets");
  });

  it("并发首次创建触发唯一约束时映射为ConflictError", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(serviceWith(query).saveBrandAssets("u1", { tone: ["专业克制"] })).rejects.toThrow(ConflictError);
  });

  it("品牌资料已存在时不带version的保存被拒绝", async () => {
    const query = vi.fn(async () => ({ rows: [brandRow()] }));
    await expect(serviceWith(query).saveBrandAssets("u1", { tone: ["热情"] })).rejects.toThrow("品牌资料已存在，请刷新后再保存");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("版本不匹配的品牌更新抛出ConflictError", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [brandRow({ version: 5 })] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(serviceWith(query).saveBrandAssets("u1", { tone: ["热情"], version: 2 })).rejects.toThrow(ConflictError);
  });

  it("携带正确version时更新成功并递增版本", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [brandRow({ version: 2 })] })
      .mockResolvedValueOnce({ rows: [brandRow({ version: 3, tone: ["热情"] })] });
    const brand = await serviceWith(query).saveBrandAssets("u1", { tone: ["热情"], version: 2 });
    expect(brand.version).toBe(3);
    expect(brand.tone).toEqual(["热情"]);
  });
});
