import { describe, expect, it, vi } from "vitest";
import { MarketingMaterialsRepository } from "./marketing-repository.js";

const now = new Date("2026-08-20T10:00:00.000Z").toISOString();

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    user_id: "u1",
    name: "会员版",
    positioning: "一体化会员经营",
    core_values: ["省心"],
    verifiable_facts: [],
    common_objections: [],
    current_benefits: [],
    prohibited_expressions: [],
    case_materials: [],
    status: "active",
    version: "3",
    archived_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function repositoryWith(query: ReturnType<typeof vi.fn>) {
  return new MarketingMaterialsRepository({ query } as any);
}

describe("MarketingMaterialsRepository listProducts", () => {
  it("搜索词通过绑定参数过滤而不是拼接进SQL", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await repositoryWith(query).listProducts("u1", { query: "会员'; DROP TABLE marketing_products;--", page: 2, limit: 20 });
    const [countSql, countParams] = query.mock.calls[0];
    const [selectSql, selectParams] = query.mock.calls[1];
    expect(countSql).toContain("count(*)");
    expect(countSql).not.toContain("ILIKE '");
    expect(selectSql).toContain("ILIKE $3");
    expect(selectSql).toContain("LIMIT $4 OFFSET $5");
    // 分页参数在 count 之后压入同一个数组,两次调用共享前缀。
    expect(countParams.slice(0, 3)).toEqual(["u1", "active", "%会员'; DROP TABLE marketing_products;--%"]);
    expect(selectParams).toEqual(["u1", "active", "%会员'; DROP TABLE marketing_products;--%", 20, 20]);
    expect(selectSql).toContain("ORDER BY updated_at DESC");
  });

  it("未提供状态时默认只返回有效产品", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await repositoryWith(query).listProducts("u1", { page: 1, limit: 20 });
    expect(query.mock.calls[0][1].slice(0, 2)).toEqual(["u1", "active"]);
  });

  it("汇总总数并把行映射为驼峰字段与数字版本", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: 7 }] })
      .mockResolvedValueOnce({ rows: [productRow()] });
    const result = await repositoryWith(query).listProducts("u1", { page: 1, limit: 20 });
    expect(result.total).toBe(7);
    expect(result.items[0]).toMatchObject({ id: "00000000-0000-0000-0000-000000000001", userId: "u1", version: 3, status: "active", archivedAt: null, createdAt: now });
  });
});

describe("MarketingMaterialsRepository products write", () => {
  it("创建产品时JSONB列以JSON字符串写入", async () => {
    const query = vi.fn(async () => ({ rows: [productRow()] }));
    await repositoryWith(query).createProduct("u1", "00000000-0000-0000-0000-000000000001", {
      name: "会员版",
      coreValues: ["省心"],
      verifiableFacts: [{ statement: "支持7天无理由退订" }],
      caseMaterials: [{ title: "制造企业案例", summary: "3 周上线" }],
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO marketing_products");
    expect(params[0]).toBe("00000000-0000-0000-0000-000000000001");
    expect(params[1]).toBe("u1");
    expect(params[5]).toBe('[{"statement":"支持7天无理由退订"}]');
    expect(params[9]).toBe('[{"title":"制造企业案例","summary":"3 周上线"}]');
  });

  it("部分更新时未提供的JSONB字段传null交给COALESCE保留旧值", async () => {
    const query = vi.fn(async () => ({ rows: [productRow({ version: "4" })] }));
    const product = await repositoryWith(query).updateProduct("u1", "00000000-0000-0000-0000-000000000001", {
      positioning: "新定位",
      version: 3,
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("version = version + 1");
    expect(sql).toContain("AND version = $3");
    expect(params[2]).toBe(3);
    expect(params[4]).toBe("新定位");
    expect([params[6], params[7], params[8], params[10]]).toEqual([null, null, null, null]);
    expect(product.version).toBe(4);
  });

  it("归档仅在有效且版本匹配的行上生效", async () => {
    const query = vi.fn(async () => ({ rows: [productRow({ status: "archived", version: "4", archived_at: now })] }));
    const product = await repositoryWith(query).archiveProduct("u1", "00000000-0000-0000-0000-000000000001", 3);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("status = 'archived'");
    expect(sql).toContain("version = $3 AND status = 'active'");
    expect(params).toEqual(["u1", "00000000-0000-0000-0000-000000000001", 3]);
    expect(product.status).toBe("archived");
    expect(product.archivedAt).toBe(now);
  });
});

describe("MarketingMaterialsRepository brand assets", () => {
  it("品牌更新携带版本条件并序列化视觉资产", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "b1", user_id: "u1", tone: ["专业克制"], visual_assets: [], standard_calls_to_action: ["预约咨询"], version: "3", created_at: now, updated_at: now }] }));
    const brand = await repositoryWith(query).updateBrandAssets("u1", {
      tone: ["专业克制"],
      visualAssets: [{ name: "logo", url: "/static/assets/logo.png" }],
      standardCallsToAction: ["预约咨询"],
      version: 2,
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("WHERE user_id = $1 AND version = $2");
    expect(params).toEqual(["u1", 2, ["专业克制"], '[{"name":"logo","url":"/static/assets/logo.png"}]', ["预约咨询"]]);
    expect(brand.version).toBe(3);
  });
});
