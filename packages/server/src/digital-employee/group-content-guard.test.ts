import { describe, expect, it, vi } from "vitest";
import { CustomerAcquisitionService } from "./acquisition-service.js";
import {
  assertGroupContentInput, buildIdentityTerms, findContactDetails, findCustomerNames, type GroupContentPolicy,
} from "./group-content-guard.js";

const policy: GroupContentPolicy = {
  identityTerms: buildIdentityTerms([
    { display_name: "李静", aliases: ["静姐", "老师", "周"] },
    { display_name: "Anna Lee", aliases: ["Ann"] },
    { display_name: "代销", aliases: [] },
  ], ["代销方案"]),
  approvedFacts: JSON.stringify({ hotline: "400-123-4567" }),
};

describe("identity terms", () => {
  it("skips single characters, generic titles and text inside a product name", () => {
    expect(policy.identityTerms).toEqual(["李静", "静姐", "anna lee", "ann"]);
  });

  it("matches Latin names on word boundaries only", () => {
    expect(findCustomerNames("Hello Ann, welcome", policy.identityTerms)).toEqual(["ann"]);
    expect(findCustomerNames("annual plan for planners", policy.identityTerms)).toEqual([]);
    expect(findCustomerNames("写给李静这样的老客户", policy.identityTerms)).toEqual(["李静"]);
  });
});

describe("contact details", () => {
  it.each([
    "电话 13812345678", "138-1234-5678", "+86 13812345678", "010-88886666", "a.b@example.com",
    "微信：abcdef", "微信号 lj_2024", "wechat: lee_001", "QQ 12345678", "13812345678",
  ])("finds %s", (text) => {
    expect(findContactDetails(text)).not.toEqual([]);
  });

  it.each(["2026-11-05 活动", "价格 9800 元", "微信 群发", "加微信咨询", "wechat group", "订单 120 份"])("ignores %s", (text) => {
    expect(findContactDetails(text)).toEqual([]);
  });

  it("allows the account's own confirmed contact", () => {
    expect(findContactDetails("拨打 400-123-4567", policy.approvedFacts)).toEqual([]);
    expect(findContactDetails("拨打 400-999-4567", policy.approvedFacts)).not.toEqual([]);
  });

  it("reads full-width digits", () => {
    expect(findContactDetails("１３８１２３４５６７８")).not.toEqual([]);
  });
});

describe("assertGroupContentInput", () => {
  it("rejects a contact without echoing it", () => {
    expect(() => assertGroupContentInput(policy, { 行动号召: "加 13812345678" })).toThrow(/行动号召包含联系方式/);
    expect(() => assertGroupContentInput(policy, { 行动号召: "加 13812345678" })).not.toThrow(/13812345678/);
  });

  it("rejects a customer name and ignores empty fields", () => {
    expect(() => assertGroupContentInput(policy, { 需求: "写给李静", 标题: undefined })).toThrow(/需求包含本账号客户/);
    expect(() => assertGroupContentInput(policy, { 需求: "写给嫌门槛高的老师们", 标题: undefined })).not.toThrow();
  });
});

function fixture(createCopy = vi.fn(async () => ({ title: "暑期", content: "写给嫌门槛高的客户的一段文案。", modelId: "m1" }))) {
  const query = vi.fn(async (sql: string, _params?: unknown[]): Promise<{ rows: any[] }> => {
    if (sql.includes("FROM de_customer_profiles")) return { rows: [{ display_name: "李静", aliases: ["静姐"] }] };
    if (sql.includes("FROM marketing_products WHERE user_id=")) return { rows: [{ name: "代销方案" }] };
    if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{ id: "p1", name: "代销方案", status: "active", version: 1 }] };
    if (sql.includes("INSERT INTO de_customer_segment_snapshots")) return { rows: [{
      id: "s1", audience_description: "公开受众", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date(),
    }] };
    if (sql.includes("WHERE asset.id=")) return { rows: [{
      id: "a1", asset_type: "text", title: "暑期", generation_status: "ready", status: "ready", version: 1,
      created_at: new Date(), updated_at: new Date(), review_flags: [{ type: "customer_name", term: "李静" }],
    }] };
    return { rows: [] };
  });
  const service = new CustomerAcquisitionService({ pool: { query } } as never, undefined, { recommend: vi.fn(), createCopy });
  const insertedAsset = () => query.mock.calls.find(([sql]) => sql.includes("INSERT INTO de_marketing_asset_library"));
  return { service, query, createCopy, insertedAsset };
}

const copyInput = {
  assetType: "copy" as const, prompt: "写一条朋友圈", publicAudience: "嫌门槛高的客户", productId: "p1",
  objective: "获得咨询", channels: ["朋友圈"], callToAction: "私信了解",
};
const draftSource = {};

describe("group content entry points", () => {
  it.each([
    ["prompt", { prompt: "写给李静的文案" }],
    ["objective", { objective: "让静姐下单" }],
    ["callToAction", { callToAction: "联系李静" }],
    ["title", { title: "致李静" }],
    ["publicAudience", { publicAudience: "李静的朋友" }],
  ])("createAsset rejects a customer name in %s before calling the model", async (_field, patch) => {
    const { service, createCopy, insertedAsset } = fixture();
    await expect(service.createAsset("u1", { ...copyInput, ...patch })).rejects.toThrow(/客户的姓名或别名/);
    expect(createCopy).not.toHaveBeenCalled();
    expect(insertedAsset()).toBeUndefined();
  });

  it("createAsset rejects a contact in the request", async () => {
    const { service, createCopy } = fixture();
    await expect(service.createAsset("u1", { ...copyInput, callToAction: "加 13812345678" })).rejects.toThrow(/联系方式/);
    expect(createCopy).not.toHaveBeenCalled();
  });

  it("prepareCustomerSegment rejects a customer name in the group name", async () => {
    const { service, query } = fixture();
    await expect(service.prepareCustomerSegment("u1", { name: "李静同类", criteria: {} } as never, draftSource)).rejects.toThrow(/客户的姓名或别名/);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO de_conversation_action_drafts"))).toBe(false);
  });

  it("prepareMarketingCampaign rejects a customer name in the objective", async () => {
    const { service, query } = fixture();
    await expect(service.prepareMarketingCampaign("u1", {
      name: "暑期活动", objective: "转化李静", channels: ["朋友圈"], callToAction: "私信了解", productId: "p1", publicAudience: "公开受众",
    } as never, draftSource)).rejects.toThrow(/客户的姓名或别名/);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO de_conversation_action_drafts"))).toBe(false);
  });

  it("rewriteAsset rejects a customer name in the instruction", async () => {
    const { service, createCopy, query } = fixture();
    const getAsset = vi.spyOn(service, "getAsset").mockResolvedValue({
      id: "a1", campaignId: "c1", segmentSnapshotId: "s1", assetType: "text", title: "暑期",
    } as never);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM de_customer_profiles")) return { rows: [{ display_name: "李静", aliases: [] }] };
      if (sql.includes("de_marketing_campaigns")) return { rows: [{
        id: "c1", product_id: "p1", objective: "获得咨询", channels: ["朋友圈"], call_to_action: "私信了解", segment_snapshot_id: "s1", name: "暑期",
      }] };
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{ id: "p1", name: "代销方案", version: 1 }] };
      if (sql.includes("de_marketing_asset_library") && sql.includes("WHERE id=")) return { rows: [{ id: "a1", campaign_id: "c1", version: 1 }] };
      return { rows: [] };
    });
    await expect(service.rewriteAsset("u1", "a1", "改成写给李静")).rejects.toThrow(/客户的姓名或别名/);
    expect(getAsset).toHaveBeenCalled();
    expect(createCopy).not.toHaveBeenCalled();
  });

  it("rewriteAsset can fix an asset whose inherited title carries the flagged name", async () => {
    const { service, createCopy, query } = fixture();
    vi.spyOn(service, "getAsset").mockResolvedValue({
      id: "a1", campaignId: "c1", segmentSnapshotId: "s1", assetType: "text", title: "致李静",
    } as never);
    const base = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("de_marketing_campaigns")) return { rows: [{
        id: "c1", product_id: "p1", objective: "获得咨询", channels: ["朋友圈"], call_to_action: "私信了解", segment_snapshot_id: "s1", name: "暑期",
      }] };
      if (sql.includes("de_customer_segment_snapshots")) return { rows: [{
        id: "s1", audience_description: "公开受众", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date(),
      }] };
      if (sql.includes("de_marketing_asset_library") && sql.includes("WHERE id=")) return { rows: [{ id: "a1", campaign_id: "c1", version: 1 }] };
      return base(sql, params);
    });
    await service.rewriteAsset("u1", "a1", "标题不要出现人名");
    expect(createCopy).toHaveBeenCalledOnce();
  });

  it("replaces generated copy that carries a contact, and flags the swap", async () => {
    const { service, insertedAsset } = fixture(vi.fn(async () => ({ title: "暑期", content: "欢迎致电 13812345678 咨询方案详情。", modelId: "m1" })));
    await service.createAsset("u1", copyInput);
    const params = insertedAsset()![1] as unknown[];
    expect(String(params[6])).not.toContain("13812345678");
    expect(params[8]).toBe("logic-fallback");
    expect(JSON.parse(String(params[10]))).toEqual([{ type: "contact_replaced" }]);
  });

  it("keeps generated copy that names a customer and flags it for review", async () => {
    const { service, insertedAsset } = fixture(vi.fn(async () => ({ title: "暑期", content: "就像李静老师说的，门槛并不高。", modelId: "m1" })));
    const asset = await service.createAsset("u1", copyInput);
    const params = insertedAsset()![1] as unknown[];
    expect(String(params[6])).toContain("李静");
    expect(JSON.parse(String(params[10]))).toEqual([{ type: "customer_name", term: "李静" }]);
    expect(asset.reviewFlags).toEqual([{ type: "customer_name", term: "李静" }]);
  });
});
