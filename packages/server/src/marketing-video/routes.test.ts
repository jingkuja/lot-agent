import { inspectMedia } from "./media.js";
import { randomUUID } from "node:crypto";
import { MarketingError } from "./repository.js";
import type { PgMarketingTextOperations } from "./operations.js";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { createMarketingVideoRoutes } from "./routes.js";
import type { AgentService } from "../services/agent-service.js";
import type { PgMarketingProjectStore } from "./repository.js";
import { completeMarketingJson } from "./text.js";
import { marketingSegmentPrompt } from "./prompt.js";

vi.mock("./media.js", () => ({ mediaCapabilities: async () => ({ composition: true, subtitles: false }), inspectMedia: vi.fn(), ownedAssetPath: vi.fn() }));
const id = "11111111-1111-4111-8111-111111111111";
function fixture(owner = "owner") {
  const project = { id, version: 1, draft: MarketingDraftSchema.parse({ script: "欢迎来到我们的店铺。来这里发现你喜欢的产品。" }), taskId: null, status: "draft" };
  const store = { get: vi.fn(async () => project), list: vi.fn(async () => []), save: vi.fn(async (..._args: Parameters<PgMarketingProjectStore["save"]>) => project), setReview: vi.fn(async () => project), reserve: vi.fn(async () => "task") };
  const service = { db: { pool: {}, getAsset: vi.fn(async () => ({ user_id: "someone-else", mime: "image/png", size_bytes: 100 })) }, marketingText: vi.fn(async (..._args: Parameters<AgentService["marketingText"]>) => ({})), jobQueue: { deliverPersisted: vi.fn(), canResumePersisted: vi.fn(async () => true) }, usageMeter: { checkQuota: vi.fn(async () => ({ ok: true })) }, modelRegistry: { getConfig: () => undefined }, modelCatalog: { defaultPricing: {}, pricing: {} } };
  const operations = {
    begin: vi.fn(async (_owner: string, requestId: string, _project: string, version: number, kind: string, _input: unknown, draft?: typeof project.draft) => {
      if (version !== project.version || project.taskId) throw new MarketingError("草稿已更新", 409);
      return { fresh: true, operation: { id: requestId, kind, status: "running" }, draft: draft ?? project.draft };
    }),
    receipt: vi.fn(), fail: vi.fn(), list: vi.fn(async () => []), recover: vi.fn(),
    finish: vi.fn(async (owner: string, requestId: string, result: { draft: typeof project.draft; analysis: string }) => {
      await store.save(owner, project.id, project.version, result.draft);
      return { id: requestId, status: "succeeded", result };
    }),
  };
  const app = new Hono<{ Variables: { userId: string } }>();
  if (owner) app.use("*", async (c, next) => { c.set("userId", owner); await next(); });
  app.route("/api/marketing-videos", createMarketingVideoRoutes(service as unknown as AgentService, "/tmp", store as unknown as PgMarketingProjectStore, operations as unknown as PgMarketingTextOperations));
  const call = (path: string, value?: unknown, method = "POST") => {
    const input = value && typeof value === "object" && (path === "/copy" || path.endsWith("/storyboard"))
      ? { clientRequestId: randomUUID(), projectId: id, version: 1, ...value } : value;
    return app.request(`/api/marketing-videos${path === "/" ? "" : path}`, input === undefined ? undefined : { method, body: JSON.stringify(input), headers: { "Content-Type": "application/json" } });
  };
  return { app, call, store, service, project, operations };
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
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.any(String), expect.any(String), "owner", expect.any(AbortSignal), expect.objectContaining({ upstreamBilling: true, onReceipt: expect.any(Function) }));
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
    f.service.marketingText.mockResolvedValueOnce({ verdict: "suspect", issues: [{ text: "产品", reason: "需要核实品牌授权", suggestion: "商品", field: "script", source: "xiaohongshu", ruleId: "platform-copyright", severity: "suspect" }] });
    expect((await f.call(`/${id}/review`, {})).status).toBe(200);
    expect(f.store.setReview).toHaveBeenCalledWith("owner", f.project, expect.objectContaining({ verdict: "suspect" }));
  });
  it("reviews every draft field with owner isolation, cancellation and local rules", async () => {
    const f = fixture();
    f.project.draft = MarketingDraftSchema.parse({ script: "普通产品介绍。", background: "项目稳赚招牌", storyboard: [{ script: "产品100%见效。", visual: "产品海报", action: "展示产品", camera: "中景" }] });
    f.service.marketingText.mockResolvedValueOnce({ verdict: "pass", issues: [] });
    expect((await f.call(`/${id}/review`, { locale: "en" })).status).toBe(200);
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.stringContaining("Write reasons and suggested replacements in en"), expect.any(String), "owner", expect.any(AbortSignal));
    const input = JSON.parse(f.service.marketingText.mock.calls[0][1] as unknown as string);
    expect(input.fields).toEqual(expect.arrayContaining([
      { field: "background", text: "项目稳赚招牌" },
      { field: "storyboard.script", shotIndex: 0, text: "产品100%见效。" },
      { field: "storyboard.visual", shotIndex: 0, text: "产品海报" },
      { field: "storyboard.action", shotIndex: 0, text: "展示产品" },
      { field: "storyboard.camera", shotIndex: 0, text: "中景" },
    ]));
    expect(f.store.setReview).toHaveBeenCalledWith("owner", f.project, expect.objectContaining({ verdict: "suspect", issues: expect.arrayContaining([expect.objectContaining({ field: "storyboard.script", shotIndex: 0, reason: expect.stringContaining("Contextual risk term") })]) }));
    const invalid = fixture();
    invalid.service.marketingText.mockResolvedValueOnce({ verdict: "suspect", issues: [{ field: "storyboard.visual", shotIndex: 14, text: "不存在", reason: "风险", suggestion: "删除", source: "douyin", ruleId: "platform-sexual", severity: "suspect" }] });
    expect((await invalid.call(`/${id}/review`, {})).status).toBe(503);
    expect(invalid.store.setReview).not.toHaveBeenCalled();
    expect((await invalid.call(`/${id}/review`, { locale: "invalid" })).status).toBe(400);
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
      expect(f.store.setReview).toHaveBeenCalledWith("owner", f.project, expect.objectContaining({ verdict: "pass", issues: [] }));
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
  it("rejects an oversized shot prompt before any quota, task or provider call", async () => {
    const f = fixture();
    const shots = [1, 2].map(() => ({ durationSec: 15, script: "欢迎来喝咖啡。", visual: "画面".repeat(300), action: "动作".repeat(200), camera: "镜头".repeat(200) }));
    f.project.draft = MarketingDraftSchema.parse({ storyboard: shots, script: storyboardScript(shots), background: "背景".repeat(300) });
    const response = await f.call(`/${id}/generate`, { version: 1, retry: false });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "生成提示词过长，请精简分镜画面、动作、镜头或背景描述。" });
    expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.service.marketingText).not.toHaveBeenCalled();
    expect(f.service.jobQueue.deliverPersisted).not.toHaveBeenCalled();
  });
  it("bounds JSON request bodies", async () => {
    const f = fixture();
    expect((await f.call(`/${id}`, { draft: "x".repeat(140000) }, "PUT")).status).toBe(413);
  });
});


describe("marketing storyboard editing", () => {
  it.each([62, 65])("preserves a %ds AI plan for a 60s target in creation and editing", async total => {
    const f = fixture(); f.project.draft.durationSec = 60;
    const shots = Array.from({ length: 5 }, (_, i) => ({ durationSec: 12 + (i < total - 60 ? 1 : 0), script: "欢迎来喝咖啡。", visual: "人物在吧台前出镜", action: "人物展示咖啡", camera: "中景" }));
    f.service.marketingText.mockResolvedValueOnce({ shots, publishTitle: "咖啡", tags: "", analysis: "展示产品" });
    const created = await f.call("/copy", { draft: { topic: "咖啡", durationSec: 60 }, locale: "zh" });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ draft: { durationSec: 60, storyboard: shots } });
    f.service.marketingText.mockResolvedValueOnce({ shots });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "调整节奏" })).status).toBe(200);
    expect(f.store.save).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ durationSec: 60, storyboard: shots }));
    Object.assign(f.project.draft, { storyboard: shots, script: storyboardScript(shots) });
    f.service.modelCatalog.pricing = { "kling-video-v3-omni": { inputPrice: 0, outputPrice: 0, unitPrice: 1 } };
    expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
    expect(f.service.usageMeter.checkQuota).toHaveBeenCalledWith("owner", total);
    for (const timings of [[14, 13, 13, 13, 13], [14, 14, 14, 14, 14]]) {
      f.project.draft.storyboard = shots.map((shot, i) => ({ ...shot, durationSec: timings[i] }));
      expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(400);
    }
    expect(f.store.reserve).toHaveBeenCalledOnce();
    expect(f.service.jobQueue.deliverPersisted).toHaveBeenCalledOnce();
  });
  it("supports AI-selected shot counts and unequal durations summing to the total", async () => {
    const f = fixture(); f.project.draft.durationSec = 17;
    const shots = [4, 6, 7].map(durationSec => ({ durationSec, script: "欢迎来喝咖啡。", visual: "人物在吧台前正面出镜", action: "人物端起杯子", camera: "中景" }));
    f.service.marketingText.mockResolvedValueOnce({ shots });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "增加一个开场镜头" })).status).toBe(200);
    expect(f.store.save).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ storyboard: shots }));
    Object.assign(f.project.draft, { storyboard: shots, script: storyboardScript(shots) });
    f.service.marketingText.mockResolvedValueOnce({ shots: [{ ...shots[1], durationSec: 15, camera: "缓慢推进" }] });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "镜头推进", index: 1 })).status).toBe(200);
    expect(f.store.save.mock.calls.at(-1)?.[3].storyboard.map(s => s.durationSec)).toEqual([4, 6, 7]);
  });
  const shots = [
    { durationSec: 15, script: "欢迎到店喝咖啡。", visual: "明亮咖啡店", action: "端起咖啡杯", camera: "中景推进" },
    { durationSec: 15, script: "发现你喜欢的咖啡。", visual: "咖啡杯特写", action: "倒入手冲咖啡", camera: "俯拍特写" },
  ];
  it("generates and persists a validated board using owner credentials without submitting video", async () => {
    const f = fixture(); f.service.marketingText.mockResolvedValueOnce({ shots });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "" })).status).toBe(200);
    expect(f.store.save).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ storyboard: shots, script: storyboardScript(shots) }));
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.any(String), expect.any(String), "owner", expect.any(AbortSignal), expect.objectContaining({ upstreamBilling: true, onReceipt: expect.any(Function) }));
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.service.jobQueue.deliverPersisted).not.toHaveBeenCalled();
  });
  it("changes only the requested shot, preserving manual edits elsewhere", async () => {
    const f = fixture(); Object.assign(f.project.draft, { storyboard: shots, script: storyboardScript(shots) });
    f.project.draft.assets = { video: id, portrait: id, voice: id };
    f.project.draft.ratio = "16:9";
    f.project.draft.subtitles = false;
    const revised = { ...shots[1], camera: "平移到产品近景" };
    f.service.marketingText.mockResolvedValueOnce({ shots: [revised] });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "改成平移", index: 1 })).status).toBe(200);
    expect(f.store.save).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ storyboard: [shots[0], revised] }));
    const [system, input] = f.service.marketingText.mock.calls[0];
    expect(JSON.parse(input)).toMatchObject({ shots, selectedIndex: 1, revisionRequest: "改成平移", ratio: "16:9", subtitles: false, generateAudio: false, materials: { portrait: 1, video: true, voice: true } });
    expect(system).toContain("index 1 (shot 2), lasting exactly 15 seconds");
    expect(input).not.toContain(id);
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

it("rejects direct video synthesis but accepts ordinary website CTAs", async () => {
  const f = fixture();
  for (const reference of ["https://www.bilibili.com/video/BV1234567890", "b23.tv/abc123", "分享 https://xhslink.com/a/abcdef", "https://example.com https://v.douyin.com/abcdef", "参考：https://b23.tv/abc123", "参考,‘b23.tv/abc123’", "参考:\"https://b23.tv/abc123\""]) {
    const result = await f.call("/copy", { draft: { copyMode: "rewrite", reference }, locale: "zh", source: { kind: "text" } });
    expect(result.status).toBe(400); expect(await result.json()).toMatchObject({ code: "VIDEO_ANALYSIS_REQUIRED" });
  }
  expect(f.service.marketingText).not.toHaveBeenCalled(); expect(f.operations.begin).not.toHaveBeenCalled();
  f.service.marketingText.mockResolvedValueOnce({ shots: [1, 2].map(() => ({ script: "现磨咖啡欢迎到店品尝。", visual: "店铺", action: "端杯", camera: "近景" })), publishTitle: "咖啡", tags: "", analysis: "介绍咖啡" });
  expect((await f.call("/copy", { draft: { copyMode: "rewrite", reference: "现磨咖啡，欢迎品尝。https://example.com/shop" }, locale: "zh", source: { kind: "text" } })).status).toBe(200);
  expect(f.service.marketingText).toHaveBeenCalledOnce();
});

it("opens and edits legacy WebM drafts while rejecting new unsupported generation", async () => {
  const f = fixture(); f.project.draft.assets.video = id;
  f.service.db.getAsset.mockResolvedValue({ user_id: "owner", mime: "video/webm", size_bytes: 100, url: "/static/legacy.webm" } as never);
  const response = await f.call(`/${id}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ assets: { [id]: { mime: "video/webm", issue: "unsupported", url: "/static/legacy.webm" } } });
  expect((await f.call(`/${id}`, { version: 1, draft: { ...f.project.draft, topic: "继续编辑" } }, "PUT")).status).toBe(200);
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(400);
  expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled(); expect(f.store.reserve).not.toHaveBeenCalled();
  Object.assign(f.project, { taskId: "finished", status: "succeeded" });
  expect((await f.call(`/${id}`, { version: 1, draft: { ...f.project.draft, publishTitle: "新标题" } }, "PUT")).status).toBe(200);
  Object.assign(f.project, { taskId: null });
  expect((await f.call(`/${id}`, { version: 1, draft: { assets: {} } }, "PUT")).status).toBe(200);
  f.project.draft.assets = {};
  expect((await f.call(`/${id}`, { version: 1, draft: { assets: { video: id } } }, "PUT")).status).toBe(400);
  f.service.db.getAsset.mockResolvedValue({ user_id: "owner", mime: "video/mp4", size_bytes: 100 });
  expect((await f.call(`/${id}`, { version: 1, draft: { assets: { video: id } } }, "PUT")).status).toBe(200);
});

it("recovers text operations through an owner and project scoped endpoint without a model call", async () => {
  const f = fixture(); const operationId = randomUUID();
  f.operations.recover.mockResolvedValue({ id: operationId, status: "conflict" });
  expect((await f.call(`/${id}/text-operations/${operationId}/recover`, {})).status).toBe(200);
  expect(f.operations.recover).toHaveBeenCalledWith("owner", id, operationId);
  expect(f.service.marketingText).not.toHaveBeenCalled();
  f.store.get.mockResolvedValueOnce(null as never);
  expect((await f.call(`/${id}/text-operations/${operationId}/recover`, {})).status).toBe(404);
  expect(f.operations.recover).toHaveBeenCalledOnce();
});

it("checks ownership of every image in all three categories", async () => {
  for (const slot of ["portrait", "background", "scene"]) {
    const f = fixture();
    f.service.db.getAsset.mockResolvedValueOnce({ user_id: "owner", mime: "image/png", size_bytes: 100 });
    const response = await f.call(`/${id}`, { version: 0, draft: { assets: { [slot]: [id, randomUUID()] } } }, "PUT");
    expect(response.status).toBe(404);
    expect(f.service.db.getAsset).toHaveBeenCalledTimes(2);
    expect(f.store.save).not.toHaveBeenCalled();
  }
});

it("restores all image metadata and submits six references in category order", async () => {
  const f = fixture();
  const ids = Array.from({ length: 6 }, () => randomUUID());
  f.project.draft.assets = { scene: ids.slice(5), background: ids.slice(3, 5), portrait: ids.slice(0, 3) };
  f.service.db.getAsset.mockImplementation(async (...args: unknown[]) => ({ user_id: "owner", mime: "image/png", size_bytes: 100, url: `/static/${args[0]}.png` }));
  const restored = await (await f.call(`/${id}`)).json() as { assets: Record<string, { url: string }> };
  for (const assetId of ids) expect(restored.assets[assetId].url).toBe(`/static/${assetId}.png`);
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
  expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ input_reference: ids.map(assetId => `/static/${assetId}.png`) }), false);
  const prompt = marketingSegmentPrompt(f.project.draft, { index: 0, script: "欢迎品尝。", durationSec: 15 }, 2);
  const roles = [...prompt.matchAll(/Use image (\d+) for ([^.]+)\./g)].map(match => ({ image: Number(match[1]), role: match[2] }));
  expect(roles).toEqual([
    ...[1, 2, 3].map(image => ({ image, role: "the presenter's identity only" })),
    ...[4, 5].map(image => ({ image, role: "the setting and spatial layout" })),
    { image: 6, role: "relevant scene composition, objects and details" },
  ]);
});

it("rejects video with four images before billing or task creation", async () => {
  const f = fixture();
  f.project.draft.assets = { video: id, portrait: [id, id], scene: [id, id] };
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(400);
  expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
  expect(f.store.reserve).not.toHaveBeenCalled();
});
it("validates reference video metadata and sends it with audio disabled", async () => {
  const f = fixture();
  const videoId = randomUUID();
  f.project.draft.assets = { video: videoId, portrait: id, voice: randomUUID() };
  f.service.db.getAsset.mockImplementation(async (...args: unknown[]) => ({ user_id: "owner", mime: args[0] === videoId ? "video/mp4" : args[0] === id ? "image/png" : "audio/wav", size_bytes: 100, url: `/static/${args[0]}` }));
  const info = { format: "mov", video: true, audio: false, duration: 5, width: 1280, height: 720, fps: 30 };
  vi.mocked(inspectMedia).mockResolvedValueOnce({ ...info, duration: 16 });
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(400);
  expect(f.store.reserve).not.toHaveBeenCalled();
  vi.mocked(inspectMedia).mockResolvedValueOnce(info);
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
  expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ reference_video: [`/static/${videoId}`], generate_audio: false, reference_audio: undefined }), false);
});
