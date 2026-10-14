import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
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
    const generated = { shots: [1, 2].map(() => ({ script: "欢迎到店发现现磨咖啡与明亮空间。", visual: "明亮咖啡店", action: "展示咖啡", camera: "中景" })), publishTitle: "转角咖啡时光", tags: "#咖啡", analysis: "介绍卖点并邀请到店。" };
    f.service.marketingText.mockResolvedValueOnce(generated);
    const copy = await f.call("/copy", { draft: { topic: "转角咖啡店：现磨咖啡、明亮空间" }, locale: "zh" });
    expect(copy.status).toBe(200);
    expect(await copy.json()).toMatchObject({ draft: { script: storyboardScript(generated.shots), storyboard: generated.shots, publishTitle: generated.publishTitle, tags: generated.tags }, analysis: generated.analysis });
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.any(String), expect.any(String), "owner", expect.any(AbortSignal), { upstreamBilling: true });
  });
  it("creates copy and complete shots from text alone, without requiring a product topic", async () => {
    const f = fixture();
    const shots = [1, 2].map(() => ({ script: "欢迎品尝现磨咖啡。", visual: "咖啡店", action: "端起咖啡", camera: "特写" }));
    f.service.marketingText.mockResolvedValueOnce({ shots, publishTitle: "咖啡", tags: "#咖啡", analysis: "从场景切入。" });
    const response = await f.call("/copy", { draft: { copyMode: "rewrite", reference: "现磨咖啡，欢迎品尝。" }, locale: "zh" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ draft: { storyboard: shots, script: storyboardScript(shots) } });
    expect(f.service.marketingText).toHaveBeenCalledOnce();
    expect(f.service.jobQueue.deliverPersisted).not.toHaveBeenCalled();
    for (const invalid of [{ shots: [shots[0]] }, { shots: shots.map(shot => ({ ...shot, script: "字".repeat(90) })) }]) {
      f.service.marketingText.mockResolvedValueOnce({ ...invalid, publishTitle: "咖啡", tags: "", analysis: "结构" });
      expect((await f.call("/copy", { draft: { topic: "咖啡" }, locale: "zh" })).status).toBe(503);
    }
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


describe("marketing storyboard editing", () => {
  const shots = [
    { script: "欢迎到店喝咖啡。", visual: "明亮咖啡店", action: "端起咖啡杯", camera: "中景推进" },
    { script: "发现你喜欢的咖啡。", visual: "咖啡杯特写", action: "倒入手冲咖啡", camera: "俯拍特写" },
  ];
  it("generates and persists a validated board using owner credentials without submitting video", async () => {
    const f = fixture(); f.service.marketingText.mockResolvedValueOnce({ shots });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "" })).status).toBe(200);
    expect(f.store.save).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ storyboard: shots, script: storyboardScript(shots) }));
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.any(String), expect.any(String), "owner", expect.any(AbortSignal));
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.service.jobQueue.deliverPersisted).not.toHaveBeenCalled();
  });
  it("changes only the requested shot, preserving manual edits elsewhere", async () => {
    const f = fixture(); Object.assign(f.project.draft, { storyboard: shots, script: storyboardScript(shots) });
    const revised = { ...shots[1], camera: "平移到产品近景" };
    f.service.marketingText.mockResolvedValueOnce({ shots: [revised] });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "改成平移", index: 1 })).status).toBe(200);
    expect(f.store.save).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ storyboard: [shots[0], revised] }));
  });
  it("rejects stale versions, submitted projects, invalid target and malformed AI output", async () => {
    const f = fixture();
    expect((await f.call(`/${id}/storyboard`, { version: 0, locale: "zh", instruction: "" })).status).toBe(409);
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "", index: 5 })).status).toBe(400);
    Object.assign(f.project, { taskId: "existing" });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "" })).status).toBe(409);
    expect(f.service.marketingText).not.toHaveBeenCalled();
    Object.assign(f.project, { taskId: null });
    for (const invalid of [{ shots: [shots[0]] }, { shots: shots.map(shot => ({ ...shot, script: "字".repeat(200) })) }, { shots: shots.map(shot => ({ ...shot, camera: "" })) }]) {
      f.service.marketingText.mockResolvedValueOnce(invalid);
      expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "" })).status).toBe(503);
    }
    expect(f.store.save).not.toHaveBeenCalled();
  });
  it("does not edit another user's missing project", async () => {
    const f = fixture(); f.store.get.mockResolvedValueOnce(null as never);
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "" })).status).toBe(404);
    expect(f.store.get).toHaveBeenCalledWith("owner", id);
    expect(f.service.marketingText).not.toHaveBeenCalled();
  });
});
