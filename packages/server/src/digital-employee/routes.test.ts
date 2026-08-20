import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDigitalEmployeeRoutes } from "./routes.js";
import { NotFoundError } from "./errors.js";

function app(service: Record<string, unknown>) {
  const server = new Hono<{ Variables: { userId: string } }>();
  server.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  server.route("/digital-employee", createDigitalEmployeeRoutes(service as any));
  return server;
}

describe("digital employee profile routes", () => {
  it("returns the user-scoped digital employee overview", async () => {
    const overview = { recentProfiles: [], totalProfiles: 0 };
    const service = { getOverview: vi.fn(async () => overview) };
    const response = await app(service).request("/digital-employee/overview");
    expect(response.status).toBe(200);
    expect(service.getOverview).toHaveBeenCalledWith("u1");
    await expect(response.json()).resolves.toEqual(overview);
  });

  it("passes the authenticated owner to list queries", async () => {
    const service = { listProfiles: vi.fn(async () => ({ items: [], page: 1, limit: 20, total: 0 })) };
    const response = await app(service).request("/digital-employee/profiles?q=%E6%9D%8E%E5%A7%90");
    expect(response.status).toBe(200);
    expect(service.listProfiles).toHaveBeenCalledWith("u1", expect.objectContaining({ query: "李姐" }));
  });

  it("does not turn an owner-scoped not-found into a different response", async () => {
    const service = { getProfile: vi.fn(async () => { throw new NotFoundError(); }) };
    const response = await app(service).request("/digital-employee/profiles/00000000-0000-0000-0000-000000000001");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("requires optimistic-lock version for archive", async () => {
    const service = { archiveProfile: vi.fn() };
    const response = await app(service).request("/digital-employee/profiles/00000000-0000-0000-0000-000000000001", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(service.archiveProfile).not.toHaveBeenCalled();
  });

  it("rejects malformed UUIDs before reaching the service", async () => {
    const service = { getProfile: vi.fn() };
    const response = await app(service).request("/digital-employee/profiles/not-a-uuid");
    expect(response.status).toBe(400);
    expect(service.getProfile).not.toHaveBeenCalled();
  });

  it("clears current-customer context within the authenticated conversation", async () => {
    const service = { clearCurrentProfile: vi.fn(async () => {}) };
    const conversationId = "00000000-0000-0000-0000-000000000009";
    const response = await app(service).request(`/digital-employee/conversation-context/${conversationId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(service.clearCurrentProfile).toHaveBeenCalledWith("u1", conversationId);
  });

  it("serves user-scoped marketing products", async () => {
    const listProducts = vi.fn(async () => ({ items: [], page: 1, limit: 20, total: 0 }));
    const service = { marketingMaterials: { listProducts } };
    const response = await app(service).request("/digital-employee/marketing/products?q=%E4%BC%9A%E5%91%98");
    expect(response.status).toBe(200);
    expect(listProducts).toHaveBeenCalledWith("u1", expect.objectContaining({ query: "会员" }));
  });

  it("validates and saves brand assets for the authenticated user", async () => {
    const saveBrandAssets = vi.fn(async (_userId, input) => ({ id: "b1", ...input, version: 1 }));
    const service = { marketingMaterials: { saveBrandAssets } };
    const response = await app(service).request("/digital-employee/marketing/brand-assets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tone: ["专业克制"], standardCallsToAction: ["预约演示"] }),
    });
    expect(response.status).toBe(200);
    expect(saveBrandAssets).toHaveBeenCalledWith("u1", expect.objectContaining({ tone: ["专业克制"] }));
  });

  it("rejects executable visual-asset links before persistence", async () => {
    const saveBrandAssets = vi.fn();
    const service = { marketingMaterials: { saveBrandAssets } };
    const response = await app(service).request("/digital-employee/marketing/brand-assets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visualAssets: [{ name: "品牌图", url: "javascript:alert(1)" }] }),
    });
    expect(response.status).toBe(400);
    expect(saveBrandAssets).not.toHaveBeenCalled();
  });

  it("lists the four-view opportunity workflow for the authenticated user", async () => {
    const list = vi.fn(async () => ({ items: [], total: 0 }));
    const service = { opportunities: { list } };
    const response = await app(service).request("/digital-employee/opportunities?view=awaiting_result&priority=high");
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith("u1", expect.objectContaining({ view: "awaiting_result", priority: "high" }));
  });

  it("requires a future date when snoozing an opportunity", async () => {
    const decide = vi.fn();
    const service = { opportunities: { decide } };
    const response = await app(service).request("/digital-employee/opportunities/00000000-0000-0000-0000-000000000011", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "snooze", snoozedUntil: "2020-01-01T00:00:00.000Z" }),
    });
    expect(response.status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it("generates a personal talk track for one customer item", async () => {
    const generateTalkTrack = vi.fn(async () => ({ reply: "您好，想跟您确认一下合同反馈。", modelId: "m1" }));
    const service = { opportunities: { generateTalkTrack } };
    const response = await app(service).request("/digital-employee/opportunities/00000000-0000-0000-0000-000000000011/talk-track", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "follow_up", message: "生成微信跟进话术", history: [] }),
    });
    expect(response.status).toBe(200);
    expect(generateTalkTrack).toHaveBeenCalledWith("u1", "00000000-0000-0000-0000-000000000011", {
      intent: "follow_up", message: "生成微信跟进话术", history: [],
    });
  });

  it("validates and saves daily opportunity discovery settings", async () => {
    const saveSettings = vi.fn(async (_userId, input) => ({ ...input, nextRunAt: null }));
    const service = { opportunities: { saveSettings } };
    const response = await app(service).request("/digital-employee/opportunity-settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, timezone: "Asia/Shanghai", dailyRunTime: "09:30", version: 0 }),
    });
    expect(response.status).toBe(200);
    expect(saveSettings).toHaveBeenCalledWith("u1", expect.objectContaining({ dailyRunTime: "09:30" }));
  });

  it("lists the authenticated user's customer-acquisition assets", async () => {
    const listAssets = vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 12 }));
    const service = { customerAcquisition: { listAssets } };
    const response = await app(service).request("/digital-employee/acquisition/assets?range=7d&assetType=poster");
    expect(response.status).toBe(200);
    expect(listAssets).toHaveBeenCalledWith("u1", expect.objectContaining({ range: "7d", assetType: "poster" }));
  });

  it("rejects campaign generation without a cohort or public audience", async () => {
    const createAsset = vi.fn();
    const service = { customerAcquisition: { createAsset } };
    const response = await app(service).request("/digital-employee/acquisition/assets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetType: "copy", prompt: "生成营销文案", productId: "p1", objective: "咨询", channels: ["朋友圈"], callToAction: "预约" }),
    });
    expect(response.status).toBe(400);
    expect(createAsset).not.toHaveBeenCalled();
  });
});
