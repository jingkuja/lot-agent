import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { createMarketingVideoRoutes } from "./routes.js";
import type { AgentService } from "../services/agent-service.js";
import type { PgMarketingProjectStore } from "./repository.js";
import { completeMarketingJson } from "./text.js";

vi.mock("./media.js", () => ({ mediaCapabilities: async () => ({ composition: true, subtitles: false }), inspectMedia: vi.fn(), ownedAssetPath: vi.fn() }));
const id = "11111111-1111-4111-8111-111111111111";
function fixture(owner = "owner") {
  const project = { id, version: 1, draft: MarketingDraftSchema.parse({ script: "欢迎来到我们的店铺。来这里发现你喜欢的产品。" }), taskId: null, status: "draft" };
  const store = { get: vi.fn(async () => project), list: vi.fn(async () => []), save: vi.fn(async () => project), setReview: vi.fn(async () => project), reserve: vi.fn(async () => "task") };
  const service = { db: { pool: {}, getAsset: vi.fn(async () => ({ user_id: "someone-else", mime: "image/png", size_bytes: 100 })) }, marketingText: vi.fn(async () => ({})), jobQueue: { deliverPersisted: vi.fn(), canResumePersisted: vi.fn(async () => true) }, usageMeter: { checkQuota: vi.fn(async () => ({ ok: true })) }, modelRegistry: { getConfig: () => undefined }, modelCatalog: { defaultPricing: {}, pricing: {} } };
  const app = new Hono<{ Variables: { userId: string } }>();
  if (owner) app.use("*", async (c, next) => { c.set("userId", owner); await next(); });
  app.route("/api/marketing-videos", createMarketingVideoRoutes(service as unknown as AgentService, "/tmp", store as unknown as PgMarketingProjectStore));
  const call = (path: string, value?: unknown, method = "POST") => app.request(`/api/marketing-videos${path === "/" ? "" : path}`, value === undefined ? undefined : { method, body: JSON.stringify(value), headers: { "Content-Type": "application/json" } });
  return { app, call, store, service, project };
}
describe("marketing project HTTP boundaries", () => {
  it("serves the frontend's mounted list, capabilities and copy paths", async () => {
    const f = fixture();
    const list = await f.call("/");
    expect(list.status).toBe(200); expect(await list.json()).toEqual({ data: [] });
    expect(f.store.list).toHaveBeenCalledWith("owner");
    const capabilities = await f.call("/capabilities");
    expect(capabilities.status).toBe(200); expect(await capabilities.json()).toMatchObject({ composition: true });
    const generated = { script: "欢迎到店发现现磨咖啡与明亮空间。", publishTitle: "转角咖啡时光", tags: "#咖啡", analysis: "介绍卖点并邀请到店。" };
    f.service.marketingText.mockResolvedValueOnce(generated);
    const copy = await f.call("/copy", { draft: { topic: "转角咖啡店：现磨咖啡、明亮空间" }, locale: "zh" });
    expect(copy.status).toBe(200);
    expect(await copy.json()).toMatchObject({ draft: { script: generated.script, publishTitle: generated.publishTitle, tags: generated.tags }, analysis: generated.analysis });
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.any(String), expect.any(String), "owner", expect.any(AbortSignal));
  });
  it("requires a session and scopes lookups to the authenticated owner", async () => {
    expect((await fixture("").call("/")).status).toBe(401);
    const f = fixture();
    f.store.get.mockResolvedValueOnce(null as never);
    expect((await f.call(`/${id}`)).status).toBe(404);
    expect(f.store.get).toHaveBeenCalledWith("owner", id);
    expect((await f.call("/not-a-uuid")).status).toBe(404);
  });
  it("rejects foreign assets, owner overrides and invalid durations before saving", async () => {
    const f = fixture();
    expect((await f.call(`/${id}`, { version: 0, draft: { assets: { portrait: id } } }, "PUT")).status).toBe(404);
    for (const draft of [{ userId: "victim" }, { durationSec: 90 }, { assets: { portrait: "https://untrusted.test" } }]) {
      expect((await f.call(`/${id}`, { version: 0, draft }, "PUT")).status).toBe(400);
    }
    expect(f.store.save).not.toHaveBeenCalled();
  });
  it("fails closed on malformed model review output", async () => {
    const f = fixture();
    expect((await f.call(`/${id}/review`, {})).status).toBe(503);
    expect(f.store.setReview).not.toHaveBeenCalled();
    f.service.marketingText.mockResolvedValueOnce({ verdict: "suspect", issues: [{ text: "最好", reason: "无法核实", suggestion: "特色" }] });
    expect((await f.call(`/${id}/review`, {})).status).toBe(200);
    expect(f.store.setReview).toHaveBeenCalledWith("owner", f.project, expect.objectContaining({ verdict: "suspect" }));
  });
  it("returns a recoverable truncation error and saves only a complete retry result", async () => {
    const f = fixture(); let truncated = true;
    const chat = vi.fn(async function* () {
      yield { type: "text" as const, content: '{"verdict":"pass","issues":[]}' };
      yield { type: "done" as const, finishReason: truncated ? "length" : "stop" };
    });
    f.service.marketingText.mockImplementation(async () => await completeMarketingJson({ chat }, "Review JSON", "现磨咖啡") as Record<string, unknown>);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await f.call(`/${id}/review`, {});
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ code: "MARKETING_TEXT_TRUNCATED", error: "模型输出未完成，请重试；当前文案已保留。" });
      expect(f.store.setReview).not.toHaveBeenCalled(); expect(chat).toHaveBeenCalledOnce();
      truncated = false;
      expect((await f.call(`/${id}/review`, {})).status).toBe(200);
      expect(f.store.setReview.mock.calls).toEqual([["owner", f.project, { verdict: "pass", issues: [] }]]);
    } finally { warn.mockRestore(); }
  });
  it("recovers a persisted pending job without new reservations or model calls", async () => {
    const f = fixture(); Object.assign(f.project, { taskId: "existing", status: "pending" });
    expect((await f.call(`/${id}/generate`, { version: 1, retry: true })).status).toBe(202);
    expect(f.service.jobQueue.deliverPersisted).toHaveBeenCalledWith("existing", "marketing.video");
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.service.marketingText).not.toHaveBeenCalled();
  });
  it("does not resume while the previous cancelled worker is active", async () => {
    const f = fixture(); Object.assign(f.project, { taskId: "existing", status: "cancelled" });
    f.service.jobQueue.canResumePersisted.mockResolvedValueOnce(false);
    expect((await f.call(`/${id}/generate`, { version: 1, retry: true })).status).toBe(409);
    expect(f.store.reserve).not.toHaveBeenCalled();
  });
  it("accepts model-generated subtitles without local subtitle support", async () => {
    const f = fixture();
    expect(f.project.draft.subtitles).toBe(true);
    const response = await f.call(`/${id}/generate`, { version: 1, retry: false });
    expect(response.status).toBe(202);
    expect(f.store.reserve).toHaveBeenCalledOnce();
    expect(f.service.jobQueue.deliverPersisted).toHaveBeenCalledWith("task", "marketing.video");
  });
  it("reports script validation failures as actionable input errors", async () => {
    const f = fixture(); f.project.draft.script = "字".repeat(300);
    const response = await f.call(`/${id}/generate`, { version: 1, retry: false });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: expect.stringContaining("过长") });
  });
  it("bounds JSON request bodies", async () => {
    const f = fixture();
    expect((await f.call(`/${id}`, { draft: "x".repeat(70000) }, "PUT")).status).toBe(413);
  });
});
