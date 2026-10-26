import { inspectMedia, mediaCapabilities } from "./media.js";
import { readImageInfo } from "./image-size.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketingError } from "./repository.js";
import type { PgMarketingTextOperations } from "./operations.js";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { CAPTION_WORDS_CHANGED, MarketingCaptionsSchema, MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { createMarketingVideoRoutes } from "./routes.js";
import type { AgentService } from "../services/agent-service.js";
import type { PgMarketingProjectStore } from "./repository.js";
import type { MarketingNarrator } from "./narration.js";
import type { MarketingKeyArtist } from "./key-art.js";
import { completeMarketingJson } from "./text.js";
import { marketingSegmentPrompt } from "./prompt.js";

vi.mock("./media.js", () => ({ mediaCapabilities: vi.fn(async () => ({ composition: true, subtitles: true })), SUBTITLES_UNAVAILABLE: "字幕不可用", inspectMedia: vi.fn(), ownedAssetPath: vi.fn() }));
vi.mock("./image-size.js", () => ({ readImageInfo: vi.fn(async () => ({ mime: "image/png", width: 800, height: 800 })) }));
const id = "11111111-1111-4111-8111-111111111111";
function fixture(owner = "owner", narrator?: Partial<MarketingNarrator>) {
  const project = { id, version: 1, draft: MarketingDraftSchema.parse({ script: "欢迎来到我们的店铺。来这里发现你喜欢的产品。" }), taskId: null, status: "draft" };
  const store = {
    segments: vi.fn(async (): Promise<any[]> => []), get: vi.fn(async () => project), list: vi.fn(async () => []),
    page: vi.fn(async (..._args: unknown[]) => ({ data: [] as unknown[], nextCursor: undefined as string | undefined })),
    save: vi.fn(async (..._args: Parameters<PgMarketingProjectStore["save"]>) => project), setReview: vi.fn(async (..._args: unknown[]) => project),
    reserve: vi.fn(async () => "task"),
    remove: vi.fn(async () => ({ files: [] as string[], keyArtFiles: [] as string[], removedBytes: 2048, removedAnalyses: [] as string[], keptAnalyses: 1 })),
    usage: vi.fn(async () => ({ videoBytes: 4096, materialBytes: 1024 })), releaseUnknownSegments: vi.fn(async () => 1),
  };
  const getAsset = vi.fn(async (_id: string): Promise<Record<string, unknown>> => ({ user_id: "someone-else", mime: "image/png", size_bytes: 100 }));
  const service = {
    db: { pool: { query: vi.fn(async () => ({ rows: [] })) }, getTask: vi.fn(async (): Promise<any> => null), getAsset,
      // One query in the server; here it reads each row through the getAsset mock.
      getAssets: async (ids: string[]) => (await Promise.all(ids.map(async assetId => {
        const asset = await getAsset(assetId); return asset ? { id: assetId, ...asset } : null;
      }))).filter(Boolean) },
    marketingText: vi.fn(async (..._args: Parameters<AgentService["marketingText"]>) => ({})),
    jobQueue: { deliverPersisted: vi.fn(), canResumePersisted: vi.fn(async () => true) }, usageMeter: { checkQuota: vi.fn(async () => ({ ok: true })) },
    modelRegistry: { getConfig: () => undefined }, modelCatalog: { defaultPricing: {}, pricing: {} },
  };
  const operations = {
    begin: vi.fn(async (_owner: string, requestId: string, _project: string, version: number, kind: string, input: unknown, draft?: typeof project.draft): Promise<{ fresh: boolean; operation: { id: string; kind: string; status: string }; draft: typeof project.draft; input: unknown }> => {
      if (version !== project.version || project.taskId) throw new MarketingError("草稿已更新", 409);
      return { fresh: true, operation: { id: requestId, kind, status: "running" }, draft: draft ?? project.draft, input };
    }),
    receipt: vi.fn(), fail: vi.fn(), list: vi.fn(async () => []), recover: vi.fn(), release: vi.fn(async (_owner: string, _project: string, operationId: string) => ({ id: operationId, kind: "copy", status: "released" })),
    finish: vi.fn(async (owner: string, requestId: string, result: { draft?: typeof project.draft; analysis?: string; review?: any }) => {
      if (result.review) await store.setReview(owner, project, result.review);
      else await store.save(owner, project.id, project.version, result.draft!);
      return { id: requestId, status: "succeeded", result };
    }),
  };
  const app = new Hono<{ Variables: { userId: string } }>();
  if (owner) app.use("*", async (c, next) => { c.set("userId", owner); await next(); });
  const keyArtist = { frozen: vi.fn(async (): Promise<any> => undefined), status: vi.fn(async () => ({ status: "missing" })), generate: vi.fn(async () => ({ keyArt: { status: "succeeded" }, error: "" })) };
  app.route("/api/marketing-videos", createMarketingVideoRoutes(service as unknown as AgentService, "/tmp", store as unknown as PgMarketingProjectStore, operations as unknown as PgMarketingTextOperations, narrator as MarketingNarrator | undefined, keyArtist as unknown as MarketingKeyArtist));
  const call = (path: string, value?: unknown, method = "POST") => {
    const input = value && typeof value === "object" && (path === "/copy" || ["/storyboard", "/review", "/publication"].some(end => path.endsWith(end)))
      ? { clientRequestId: randomUUID(), projectId: id, version: 1, ...value } : value;
    return app.request(`/api/marketing-videos${path === "/" ? "" : path}`, input === undefined ? undefined : { method, body: JSON.stringify(input), headers: { "Content-Type": "application/json" } });
  };
  return { app, call, store, service, project, operations, keyArtist };
}
describe("marketing project HTTP boundaries", () => {
  it("protects a legacy marketing upload and signs only its preview, leaving the canonical URL intact", async () => {
    vi.stubEnv("SECRET_MASTER_KEY", "11".repeat(32));
    try {
      const f = fixture();
      const asset = { id, user_id: "owner", type: "upload", storage_key: "portrait.png", url: "/static/uploads/portrait.png", mime: "image/png", size_bytes: 10 };
      f.project.draft.assets = { portrait: [id] };
      const protect = vi.fn();
      Object.assign(f.service.db, { protectMarketingUpload: protect });
      f.service.db.getAsset.mockResolvedValue(asset);
      const response = await f.call(`/${id}`);
      expect(response.status).toBe(200);
      expect((await response.json() as { assets: Record<string, { url: string }> }).assets[id].url).toContain("material_token=");
      expect(protect).toHaveBeenCalledWith(id, "owner");
      expect(asset.url).toBe("/static/uploads/portrait.png");
    } finally { vi.unstubAllEnvs(); }
  });
  it("serves polled task state without reading or signing materials", async () => {
    const f = fixture();
    const state = { id, version: 3, taskId: "task", status: "failed", progress: 40, error: "x", errorCode: "TIMED_OUT" };
    Object.assign(f.store, { taskState: vi.fn(async (owner: string) => owner === "owner" ? state : null) });
    const response = await f.call(`/${id}/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(f.service.db.getAsset).not.toHaveBeenCalled();
    expect(f.store.get).not.toHaveBeenCalled();
    const other = fixture("intruder");
    Object.assign(other.store, { taskState: vi.fn(async (owner: string) => owner === "owner" ? state : null) });
    expect((await other.call(`/${id}/status`)).status).toBe(404);
  });
  it("serves the frontend's mounted list, capabilities and copy paths", async () => {
    const f = fixture();
    const list = await f.call("/");
    expect(list.status).toBe(200); expect(await list.json()).toEqual({ data: [] });
    expect(f.store.page).toHaveBeenCalledWith("owner", { limit: 20, cursor: undefined, query: undefined });
    f.store.page.mockResolvedValueOnce({ data: [], nextCursor: "next" });
    expect(await (await f.app.request("/api/marketing-videos?limit=10&cursor=abc&q=%E5%92%96%E5%95%A1")).json()).toEqual({ data: [], nextCursor: "next" });
    expect(f.store.page).toHaveBeenLastCalledWith("owner", { limit: 10, cursor: "abc", query: "咖啡" });
    const capabilities = await f.call("/capabilities");
    expect(capabilities.status).toBe(200); expect(await capabilities.json()).toMatchObject({ composition: true });
    const generated = { shots: [1, 2].map(() => ({ script: "欢迎到店发现现磨咖啡与明亮空间。", visual: "明亮咖啡店", action: "展示咖啡", camera: "中景" })), publishTitle: "转角咖啡时光", tags: "#咖啡", analysis: "介绍卖点并邀请到店。" };
    f.service.marketingText.mockResolvedValueOnce(generated);
    const copy = await f.call("/copy", { draft: { topic: "转角咖啡店：现磨咖啡、明亮空间" }, locale: "zh" });
    expect(copy.status).toBe(200);
    expect(await copy.json()).toMatchObject({ draft: { script: storyboardScript(generated.shots), storyboard: generated.shots, publishTitle: generated.publishTitle, tags: generated.tags }, analysis: generated.analysis });
    // A browser disconnect must not abort a recorded paid request into an unknown outcome.
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.any(String), expect.any(String), "owner", undefined, expect.objectContaining({ upstreamBilling: true, onReceipt: expect.any(Function) }));
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
  it("deletes only the owner's draft and waits for a cancelled worker to finish", async () => {
    const f = fixture();
    const remove = () => f.app.request(`/api/marketing-videos/${id}`, { method: "DELETE" });
    const removed = await remove();
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, removedBytes: 2048, keptAnalyses: 1 });
    expect(f.store.remove).toHaveBeenCalledWith("owner", id);
    f.store.get.mockResolvedValueOnce(null as never);
    expect((await remove()).status).toBe(404);
    expect((await f.app.request("/api/marketing-videos/not-a-uuid", { method: "DELETE" })).status).toBe(404);
    Object.assign(f.project, { taskId: "existing", status: "cancelled" });
    f.service.jobQueue.canResumePersisted.mockResolvedValueOnce(false);
    expect((await remove()).status).toBe(409);
    expect(f.store.remove).toHaveBeenCalledOnce();
  });
  it("reports the owner's draft space usage", async () => {
    const f = fixture();
    const response = await f.app.request("/api/marketing-videos/usage");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ videoBytes: 4096, materialBytes: 1024, narrationBytes: 0, analysisBytes: 0, analysisLimitBytes: 2 * 1024 ** 3 });
    expect(f.store.usage).toHaveBeenCalledWith("owner");
  });
  it("removes the deleted draft's generated files only inside the assets and uploads folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-delete-"));
    try {
      await mkdir(join(root, "assets"));
      await mkdir(join(root, "uploads"));
      await writeFile(join(root, "assets", "final.mp4"), "video");
      await writeFile(join(root, "uploads", "still.png"), "image");
      await writeFile(join(root, "outside.mp4"), "keep");
      const f = fixture();
      f.store.remove.mockResolvedValueOnce({ files: ["final.mp4", "../outside.mp4"], keyArtFiles: ["still.png", "../outside.mp4"], removedBytes: 5, removedAnalyses: [], keptAnalyses: 0 } as never);
      const app = new Hono<{ Variables: { userId: string } }>();
      app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
      app.route("/api/marketing-videos", createMarketingVideoRoutes(f.service as unknown as AgentService, root, f.store as unknown as PgMarketingProjectStore, f.operations as unknown as PgMarketingTextOperations));
      expect((await app.request(`/api/marketing-videos/${id}`, { method: "DELETE" })).status).toBe(200);
      expect(await readdir(join(root, "assets"))).toEqual([]);
      expect(await readdir(join(root, "uploads"))).toEqual([]);
      expect(await readFile(join(root, "outside.mp4"), "utf8")).toBe("keep");
    } finally { await rm(root, { recursive: true, force: true }); }
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
    // Recorded like /copy: not aborted by a browser disconnect, receipt saved before applying.
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.stringContaining("Write reasons and suggested replacements in en"), expect.any(String), "owner", undefined, expect.objectContaining({ onReceipt: expect.any(Function), model: "deepseek-v4.1-flash" }));
    expect(f.operations.begin).toHaveBeenCalledWith("owner", expect.any(String), id, 1, "review", { version: 1, locale: "en" });
    const input = JSON.parse(f.service.marketingText.mock.calls[0][1] as unknown as string);
    expect(input.fields).toEqual(expect.arrayContaining([
      { field: "background", text: "项目稳赚招牌" },
      { field: "storyboard.script", shotIndex: 0, text: "产品100%见效。" },
      { field: "storyboard.visual", shotIndex: 0, text: "产品海报" },
      { field: "storyboard.action", shotIndex: 0, text: "展示产品" },
      { field: "storyboard.camera", shotIndex: 0, text: "中景" },
    ]));
    expect(f.store.setReview).toHaveBeenCalledWith("owner", f.project, expect.objectContaining({ verdict: "suspect", issues: expect.arrayContaining([expect.objectContaining({ field: "storyboard.script", shotIndex: 0, reason: expect.stringContaining("Contextual risk term") })]) }));
    // A paid check keeps its located findings; one that cannot be located is only counted.
    const unlocated = fixture();
    const finding = { reason: "风险", suggestion: "删除", source: "douyin", ruleId: "platform-sexual", severity: "suspect" };
    unlocated.service.marketingText.mockResolvedValueOnce({ verdict: "suspect", issues: [{ ...finding, field: "storyboard.visual", shotIndex: 14, text: "不存在" }] });
    expect((await unlocated.call(`/${id}/review`, {})).status).toBe(200);
    expect(unlocated.store.setReview).toHaveBeenCalledWith("owner", unlocated.project, expect.objectContaining({ verdict: "suspect", dropped: 1 }));
    const invalid = fixture();
    invalid.service.marketingText.mockResolvedValueOnce({ verdict: "pass", issues: [{ ...finding, field: "script", text: "普通" }] });
    expect((await invalid.call(`/${id}/review`, {})).status).toBe(503);
    expect(invalid.store.setReview).not.toHaveBeenCalled();
    expect((await invalid.call(`/${id}/review`, { locale: "invalid" })).status).toBe(400);
  });
  it("re-checks only the fields frozen in the review delta and keeps carried findings", async () => {
    const f = fixture();
    f.project.draft = MarketingDraftSchema.parse({ script: "普通产品介绍。", publishTitle: "门店" });
    const carried = { field: "publishTitle", text: "门店", reason: "需要核实", suggestion: "", severity: "suspect", source: "douyin", ruleId: "platform-misleading-claims" };
    f.operations.begin.mockImplementationOnce(async (_owner, requestId, _project, _version, kind, input) =>
      ({ fresh: true, operation: { id: requestId, kind, status: "running" }, draft: f.project.draft, input: { ...(input as object), delta: { fields: [{ field: "script" }], carried: [carried] } } }));
    f.service.marketingText.mockResolvedValueOnce({ verdict: "pass", issues: [] });
    expect((await f.call(`/${id}/review`, {})).status).toBe(200);
    expect(f.service.marketingText.mock.calls[0][0]).toContain('only these fields changed: [{"field":"script"}]');
    expect(f.store.setReview).toHaveBeenCalledWith("owner", f.project, expect.objectContaining({ verdict: "suspect", issues: [expect.objectContaining({ field: "publishTitle", text: "门店" })] }));
    f.service.marketingText.mockResolvedValueOnce({ verdict: "pass", issues: [] });
    await f.call(`/${id}/review`, {});
    expect(f.service.marketingText.mock.calls[1][0]).not.toContain("Incremental re-check");
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
    expect(await response.json()).toMatchObject({ error: "生成提示词过长，请精简分镜画面、动作、镜头、背景描述或统一人物、产品与场景设定。" });
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
    f.service.modelCatalog.pricing = { "grok-imagine-video-1.5": { inputPrice: 0, outputPrice: 0, unitPrice: 1 } };
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
    const shots = [8, 9].map(durationSec => ({ durationSec, script: "欢迎来喝咖啡。", visual: "人物在吧台前正面出镜", action: "人物端起杯子", camera: "中景" }));
    f.service.marketingText.mockResolvedValueOnce({ shots });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "增加一个开场镜头" })).status).toBe(200);
    expect(f.store.save).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ storyboard: shots }));
    Object.assign(f.project.draft, { storyboard: shots, script: storyboardScript(shots) });
    f.service.marketingText.mockResolvedValueOnce({ shots: [{ ...shots[1], durationSec: 15, camera: "缓慢推进" }] });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "镜头推进", index: 1 })).status).toBe(200);
    expect(f.store.save.mock.calls.at(-1)?.[3].storyboard.map(s => s.durationSec)).toEqual([8, 9]);
  });
  it("joins adjacent AI shots that fit one clip, but never on a single-shot edit", async () => {
    const f = fixture(); f.project.draft.durationSec = 17;
    const shot = (durationSec: number, script: string) => ({ durationSec, script, visual: `${script}画面`, action: "端起杯子", camera: "中景" });
    f.service.marketingText.mockResolvedValueOnce({ shots: [shot(4, "欢迎。"), shot(6, "来喝咖啡。"), shot(7, "现磨咖啡等你来。")] });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "" })).status).toBe(200);
    const saved = f.store.save.mock.calls.at(-1)![3];
    expect(saved.storyboard).toEqual([
      { durationSec: 10, script: "欢迎。\n来喝咖啡。", visual: "欢迎。画面\n来喝咖啡。画面", action: "端起杯子\n端起杯子", camera: "中景\n中景" },
      shot(7, "现磨咖啡等你来。"),
    ]);
    // The copy reads the same as before the shots were joined.
    expect(saved.script).toBe("欢迎。\n来喝咖啡。\n现磨咖啡等你来。");
    const board = [shot(5, "欢迎。"), shot(5, "来喝咖啡。"), shot(7, "现磨咖啡等你来。")];
    Object.assign(f.project.draft, { storyboard: board, script: storyboardScript(board) });
    f.service.marketingText.mockResolvedValueOnce({ shots: [{ ...board[1], camera: "缓慢推进" }] });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "镜头推进", index: 1 })).status).toBe(200);
    expect(f.store.save.mock.calls.at(-1)?.[3].storyboard.map(s => s.durationSec)).toEqual([5, 5, 7]);
  });
  const shots = [
    { durationSec: 15, script: "欢迎到店喝咖啡。", visual: "明亮咖啡店", action: "端起咖啡杯", camera: "中景推进" },
    { durationSec: 15, script: "发现你喜欢的咖啡。", visual: "咖啡杯特写", action: "倒入手冲咖啡", camera: "俯拍特写" },
  ];
  it("generates and persists a validated board using owner credentials without submitting video", async () => {
    const f = fixture(); f.service.marketingText.mockResolvedValueOnce({ shots });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "" })).status).toBe(200);
    expect(f.store.save).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ storyboard: shots, script: storyboardScript(shots) }));
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.any(String), expect.any(String), "owner", undefined, expect.objectContaining({ upstreamBilling: true, onReceipt: expect.any(Function) }));
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.service.jobQueue.deliverPersisted).not.toHaveBeenCalled();
  });
  it("changes only the requested shot, preserving manual edits elsewhere", async () => {
    const f = fixture(); Object.assign(f.project.draft, { storyboard: shots, script: storyboardScript(shots) });
    f.project.draft.assets = { portrait: id, voice: id };
    f.project.draft.ratio = "16:9";
    f.project.draft.subtitles = false;
    const revised = { ...shots[1], camera: "平移到产品近景" };
    f.service.marketingText.mockResolvedValueOnce({ shots: [revised] });
    expect((await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "改成平移", index: 1 })).status).toBe(200);
    expect(f.store.save).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ storyboard: [shots[0], revised] }));
    const [system, input] = f.service.marketingText.mock.calls[0];
    expect(JSON.parse(input)).toMatchObject({ shots, selectedIndex: 1, revisionRequest: "改成平移", ratio: "16:9", subtitles: false, generateAudio: true, materials: { portrait: 1, video: false, voice: true } });
    expect(system).toContain("index 1 (shot 2), lasting exactly 15 seconds");
    expect(input).not.toContain(id);
  });
  it("asks for a full storyboard before a paid edit when a reference video cannot fit 8-second shots", async () => {
    const f = fixture(); Object.assign(f.project.draft, { storyboard: shots, script: storyboardScript(shots) });
    f.project.draft.assets = { video: id };
    const response = await f.call(`/${id}/storyboard`, { version: 1, locale: "zh", instruction: "改成平移", index: 1 });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("8 秒");
    expect(f.service.marketingText).not.toHaveBeenCalled();
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

it("skips the material lookup when an autosave keeps the saved materials", async () => {
  const f = fixture();
  f.project.draft.assets = { portrait: [id] };
  const response = await f.call(`/${id}`, { version: 1, draft: { script: "改了一句口播。", assets: { portrait: [id] } } }, "PUT");
  expect(response.status).toBe(200);
  expect(f.service.db.getAsset).not.toHaveBeenCalled();
  expect(f.store.save).toHaveBeenCalledOnce();
  // A changed material is looked up again and refused when it is not the owner's.
  expect((await f.call(`/${id}`, { version: 1, draft: { assets: { portrait: [id, randomUUID()] } } }, "PUT")).status).toBe(404);
});

it("restores all image metadata and submits references in category order", async () => {
  const f = fixture();
  const ids = Array.from({ length: 8 }, () => randomUUID());
  f.project.draft.assets = { scene: ids.slice(7), background: ids.slice(5, 7), product: ids.slice(3, 5), portrait: ids.slice(0, 3) };
  f.service.db.getAsset.mockImplementation(async (...args: unknown[]) => ({ user_id: "owner", mime: "image/png", size_bytes: 100, url: `/static/${args[0]}.png` }));
  const restored = await (await f.call(`/${id}`)).json() as { assets: Record<string, { url: string }> };
  for (const assetId of ids) expect(restored.assets[assetId].url).toBe(`/static/${assetId}.png`);
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
  expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ input_reference: ids.map(assetId => `/static/${assetId}.png`) }), false);
  const prompt = marketingSegmentPrompt(f.project.draft, { index: 0, script: "欢迎品尝。", durationSec: 15 }, 2);
  const roles = [...prompt.matchAll(/Use ((?:<IMAGE_\d+>(?:, )?)+) for ([^.]+)\./g)]
    .flatMap(match => [...match[1].matchAll(/<IMAGE_(\d+)>/g)].map(tag => ({ image: Number(tag[1]), role: match[2] })));
  expect(roles).toEqual([
    ...[0, 1, 2].map(image => ({ image, role: "the presenter's identity only" })),
    ...[3, 4].map(image => ({ image, role: "the product's exact appearance" })),
    ...[5, 6].map(image => ({ image, role: "the setting and spatial layout" })),
    { image: 7, role: "relevant scene composition, objects and details" },
  ]);
});

it("submits the key-art still after the chosen images and freezes it for shot redos", async () => {
  const f = fixture();
  const portrait = randomUUID(); const still = randomUUID();
  f.project.draft.assets = { portrait: [portrait] };
  f.service.db.getAsset.mockImplementation(async (...args: unknown[]) => ({ user_id: "owner", mime: "image/png", size_bytes: 100, url: `/static/${args[0]}.png` }));
  f.keyArtist.frozen.mockResolvedValueOnce({ id: still, user_id: "owner", url: `/static/uploads/${still}.png` });
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
  expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ input_reference: [`/static/${portrait}.png`, `/static/uploads/${still}.png`], key_art: still }), false);
  const prompt = marketingSegmentPrompt(f.project.draft, { index: 0, script: "欢迎品尝。", durationSec: 15 }, 2, undefined, undefined, undefined, true);
  expect(prompt).toContain("Use <IMAGE_0> for the presenter's identity only.");
  expect(prompt).toContain("<IMAGE_1> is the key-art still shared by every shot");
  expect(prompt).toContain("portraits still decide the face");
  expect(marketingSegmentPrompt(f.project.draft, { index: 0, script: "欢迎品尝。", durationSec: 15 }, 2)).not.toContain("key-art");
});

it("makes a key-art still only for an unsubmitted draft at its saved version", async () => {
  const f = fixture();
  expect((await f.call(`/${id}/key-art`, { version: 0 })).status).toBe(409);
  expect((await f.call(`/${id}/key-art`, { version: 1, redo: "yes" })).status).toBe(400);
  const made = await f.call(`/${id}/key-art`, { version: 1, redo: true });
  expect(made.status).toBe(200);
  expect(await made.json()).toEqual({ version: 1, keyArt: { status: "succeeded" }, error: "" });
  expect(f.keyArtist.generate).toHaveBeenCalledWith("owner", id, f.project.draft, expect.anything(), true);
  Object.assign(f.project, { taskId: "task" });
  expect((await f.call(`/${id}/key-art`, { version: 1 })).status).toBe(409);
  expect(f.keyArtist.generate).toHaveBeenCalledOnce();
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
  f.project.draft.assets = { video: videoId, voice: randomUUID() };
  f.service.db.getAsset.mockImplementation(async (...args: unknown[]) => ({ user_id: "owner", mime: args[0] === videoId ? "video/mp4" : "audio/wav", size_bytes: 100, url: `/static/${args[0]}` }));
  // Kling's 3–15.5 s / 700 px limits no longer apply to Grok submissions.
  const info = { format: "mov", video: true, audio: false, duration: 20, width: 640, height: 360, fps: 30 };
  vi.mocked(inspectMedia).mockResolvedValueOnce({ ...info, video: false });
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(400);
  expect(f.store.reserve).not.toHaveBeenCalled();
  vi.mocked(inspectMedia).mockResolvedValueOnce(info);
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
  expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ marketingInputVersion: 4, modelId: "grok-imagine-video-1.5", reference_video: [`/static/${videoId}`], generate_audio: false, reference_audio: undefined, local_subtitles: true }), false);
});
it("burns the captions of a model-voiced video locally, so it needs a host that can burn them", async () => {
  const f = fixture();
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
  expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ generate_audio: true, local_subtitles: true }), false);
  expect((f.store.reserve.mock.calls[0] as unknown[])[3]).not.toHaveProperty("narration");
  vi.mocked(mediaCapabilities).mockResolvedValue({ composition: true, subtitles: false });
  try {
    const blocked = fixture();
    const response = await blocked.call(`/${id}/generate`, { version: 1, retry: false });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "当前环境不支持字幕，可关闭字幕后生成。" });
    blocked.project.draft.subtitles = false;
    expect((await blocked.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
  } finally { vi.mocked(mediaCapabilities).mockResolvedValue({ composition: true, subtitles: true }); }
});

it("submits new clips with the configured model profile", async () => {
  process.env.MARKETING_VIDEO_MODEL = "kling-video-v3-omni";
  try {
    const f = fixture();
    expect(await (await f.call("/capabilities", undefined, "GET")).json()).toMatchObject({ model: { modelId: "kling-video-v3-omni", imagesWithReferenceVideo: 3 } });
    const videoId = randomUUID();
    f.project.draft.assets = { video: videoId, portrait: id };
    f.service.db.getAsset.mockImplementation(async (...args: unknown[]) => ({ user_id: "owner", mime: args[0] === videoId ? "video/mp4" : "image/png", size_bytes: 100, url: `/static/${args[0]}` }));
    // Kling keeps its documented reference video limits.
    vi.mocked(inspectMedia).mockResolvedValueOnce({ format: "mov", video: true, audio: false, duration: 20, width: 1280, height: 720, fps: 30 });
    expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(400);
    vi.mocked(inspectMedia).mockResolvedValueOnce({ format: "mov", video: true, audio: false, duration: 5, width: 1280, height: 720, fps: 30 });
    expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
    expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ modelId: "kling-video-v3-omni", input_reference: [`/static/${id}`] }), false);
  } finally { delete process.env.MARKETING_VIDEO_MODEL; }
});

it("rejects Grok reference video with images and 1080p references before billing", async () => {
  const f = fixture();
  f.project.draft.assets = { video: randomUUID(), portrait: id };
  expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(400);
  f.project.draft.assets = { portrait: id };
  f.project.draft.quality = "1080p";
  const response = await f.call(`/${id}/generate`, { version: 1, retry: false });
  expect(response.status).toBe(400);
  expect((await response.json() as { error: string }).error).toContain("720p");
  expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
  expect(f.store.reserve).not.toHaveBeenCalled();
});


describe("explicit release of unknown paid outcomes", () => {
  const operationId = "22222222-2222-4222-8222-222222222222";
  it("releases an unknown text operation only through the owner-scoped store", async () => {
    const f = fixture();
    const response = await f.call(`/${id}/text-operations/${operationId}/release`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operation: { id: operationId, status: "released" }, project: { id } });
    expect(f.operations.release).toHaveBeenCalledWith("owner", id, operationId);
    expect(f.service.marketingText).not.toHaveBeenCalled();
    expect((await f.call(`/${id}/text-operations/not-a-uuid/release`, {})).status).toBe(404);
  });
  it("releases unknown clips without resubmitting, and refuses while the job may still run", async () => {
    const f = fixture();
    expect((await f.call(`/${id}/unknown-segments/release`, {})).status).toBe(409);
    Object.assign(f.project, { taskId: "parent", status: "failed" });
    f.service.jobQueue.canResumePersisted.mockResolvedValueOnce(false);
    expect((await f.call(`/${id}/unknown-segments/release`, {})).status).toBe(409);
    expect(f.store.releaseUnknownSegments).not.toHaveBeenCalled();
    const response = await f.call(`/${id}/unknown-segments/release`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ released: 1, project: { id } });
    expect(f.store.releaseUnknownSegments).toHaveBeenCalledWith("owner", id);
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.service.jobQueue.deliverPersisted).not.toHaveBeenCalled();
    expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
  });
});

describe("historical generation recovery", () => {
  function historical() {
    const f = fixture();
    Object.assign(f.project, { taskId: "parent", status: "failed" });
    f.project.draft.assets.video = id;
    const frozen = structuredClone(f.project.draft);
    f.service.db.getTask.mockResolvedValue({ id: "parent", type: "marketing.video", user_id: "owner", status: "failed", input: { projectId: id, draft: frozen, generate_audio: true } });
    f.store.segments.mockResolvedValue([0, 1].map(slot => ({ slot, task_id: `child-${slot}`, duration_sec: "15", script: "欢迎到店。", vendor_task_id: `vendor-${slot}` })));
    f.store.reserve.mockResolvedValue("parent");
    f.service.db.getAsset.mockResolvedValue({ user_id: "owner", mime: "video/webm", size_bytes: 100, url: "/static/legacy.webm" } as never);
    vi.mocked(inspectMedia).mockClear();
    return f;
  }
  it("reaches same-ID poll/download recovery for legacy WebM, using frozen input and no quota", async () => {
    const f = historical();
    // Current presentation metadata and expired source analysis are irrelevant.
    f.project.draft.assets.video = "another-display-reference";
    const response = await f.call(`/${id}/generate`, { version: 1, retry: true });
    expect(response.status).toBe(202);
    expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, {}, true);
    expect(f.service.jobQueue.deliverPersisted).toHaveBeenCalledWith("parent", "marketing.video");
    expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
    expect(inspectMedia).not.toHaveBeenCalled();
    expect(f.service.db.getAsset).toHaveBeenCalledWith(id);
    expect(f.service.marketingText).not.toHaveBeenCalled();
  });
  it("applies strict input rules to any mixed segment requiring a new submission", async () => {
    const f = historical();
    f.store.segments.mockResolvedValue([
      { slot: 0, task_id: "child-0", duration_sec: 15, script: "欢迎到店。", vendor_task_id: "known" },
      { slot: 1, task_id: "child-1", duration_sec: 15, script: "欢迎到店。", vendor_task_id: null },
    ]);
    expect((await f.call(`/${id}/generate`, { version: 1, retry: true })).status).toBe(400);
    expect(f.store.reserve).not.toHaveBeenCalled(); expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
  });
  it("blocks a mixed unknown result before reserving, billing or delivering anything", async () => {
    const f = historical();
    f.store.segments.mockResolvedValue([
      { slot: 0, task_id: "child-0", duration_sec: 15, vendor_task_id: null },
      { slot: 1, task_id: "child-1", duration_sec: 15, vendor_task_id: "marketing-submission-unknown", output: { retrySafe: true } },
    ]);
    const result = await f.call(`/${id}/generate`, { version: 1, retry: true });
    expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ error: expect.stringContaining("结果未知") });
    expect(f.store.reserve).not.toHaveBeenCalled(); expect(f.service.jobQueue.deliverPersisted).not.toHaveBeenCalled();
    expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
  });
  it("never bypasses frozen task, material or output ownership during recovery", async () => {
    const f = historical();
    f.service.db.getTask.mockResolvedValueOnce({ user_id: "other" });
    expect((await f.call(`/${id}/generate`, { version: 1, retry: true })).status).toBe(409);
    f.service.db.getAsset.mockResolvedValue({ user_id: "other", mime: "video/webm", size_bytes: 100 });
    expect((await f.call(`/${id}/generate`, { version: 1, retry: true })).status).toBe(404);
    f.store.segments.mockResolvedValue([0, 1].map(slot => ({ slot, task_id: `child-${slot}`, duration_sec: 15, output: { assetIds: ["foreign-output"] } })));
    expect((await f.call(`/${id}/generate`, { version: 1, retry: true })).status).toBe(404);
    expect(f.store.reserve).not.toHaveBeenCalled();
  });
});

describe("single shot redo", () => {
  const shots = [0, 1].map(slot => ({ durationSec: 8, script: `欢迎来到我们的店铺第${slot + 1}段。`, visual: "人物在店内", action: "展示产品", camera: "中景" }));
  function made() {
    const f = fixture();
    const draft = MarketingDraftSchema.parse({ durationSec: 15, storyboard: shots, script: storyboardScript(shots) });
    Object.assign(f.project, { draft, taskId: "parent", status: "succeeded", revision: { draft, modelId: "grok-imagine-video-1.5", reusable: [true, true] } });
    f.service.db.getTask.mockResolvedValue({ id: "parent", type: "marketing.video", user_id: "owner", status: "succeeded",
      input: { projectId: id, draft, generate_audio: true, marketingInputVersion: 3, modelId: "grok-imagine-video-1.5" } });
    f.store.segments.mockResolvedValue([0, 1].map(slot => ({ slot, task_id: `child-${slot}`, duration_sec: 8, script: shots[slot].script,
      output: { assetIds: [`clip-${slot}`], ...(slot ? { reusedFrom: "first-child-1" } : {}) } })));
    f.service.db.getAsset.mockImplementation(async (assetId: string) => ({ user_id: "owner", task_id: assetId === "clip-0" ? "child-0" : "first-child-1" }) as never);
    Object.assign(f.store, { revise: vi.fn(async () => "revision") });
    return f as typeof f & { store: typeof f.store & { revise: ReturnType<typeof vi.fn> } };
  }
  it("composes again with new caption line breaks, but never with changed caption words", async () => {
    const f = made();
    f.service.db.getTask.mockResolvedValue({ id: "parent", type: "marketing.video", user_id: "owner", status: "succeeded",
      input: { projectId: id, draft: f.project.draft, generate_audio: true, local_subtitles: true, marketingInputVersion: 4, modelId: "grok-imagine-video-1.5" } });
    const caption = (lines: string[]) => ({ shots: [{ script: shots[0].script, lines, offsetSec: 0.2 }] });
    f.project.draft = { ...f.project.draft, captions: MarketingCaptionsSchema.parse(caption(["欢迎来到", "我们的店铺第1段"])) };
    expect((await f.call(`/${id}/revise`, { version: 1, shots: [] })).status).toBe(202);
    f.project.draft = { ...f.project.draft, captions: MarketingCaptionsSchema.parse(caption(["欢迎来到", "你们的店铺第1段"])) };
    const refused = await f.call(`/${id}/revise`, { version: 1, shots: [] });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: CAPTION_WORDS_CHANGED });
    expect(f.store.revise).toHaveBeenCalledOnce();
  });
  it("submits only the chosen shot and checks quota for its seconds", async () => {
    const f = made();
    const response = await f.call(`/${id}/revise`, { version: 1, shots: [1] });
    expect(response.status).toBe(202);
    expect(f.store.revise).toHaveBeenCalledWith("owner", id, 1, "parent", [1], {});
    expect(f.service.jobQueue.deliverPersisted).toHaveBeenCalledWith("revision", "marketing.video");
    expect(f.service.usageMeter.checkQuota).toHaveBeenCalledOnce();
    expect(f.store.reserve).not.toHaveBeenCalled();
  });
  it("refuses a video without a revision base, a stale version or an invalid choice before any charge", async () => {
    const f = made();
    for (const body of [{ version: 1, shots: [1, 1] }, { version: 1, shots: [0.5] }, { version: 1 }]) {
      expect((await f.call(`/${id}/revise`, body)).status).toBe(400);
    }
    expect((await f.call(`/${id}/revise`, { version: 1, shots: [2] })).status).toBe(400);
    expect((await f.call(`/${id}/revise`, { version: 2, shots: [0] })).status).toBe(409);
    f.service.jobQueue.canResumePersisted.mockResolvedValueOnce(false);
    expect((await f.call(`/${id}/revise`, { version: 1, shots: [0] })).status).toBe(409);
    Object.assign(f.project, { revision: undefined });
    expect((await f.call(`/${id}/revise`, { version: 1, shots: [0] })).status).toBe(409);
    expect(f.store.revise).not.toHaveBeenCalled(); expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
  });
  it("composes the kept clips again when no shot is chosen", async () => {
    const f = made();
    expect((await f.call(`/${id}/revise`, { version: 1, shots: [] })).status).toBe(202);
    expect(f.store.revise).toHaveBeenCalledWith("owner", id, 1, "parent", [], {});
    expect(f.service.jobQueue.deliverPersisted).toHaveBeenCalledWith("revision", "marketing.video");
  });
  it("keeps only clips that still belong to this owner and draft", async () => {
    const f = made();
    f.service.db.getAsset.mockImplementation(async () => ({ user_id: "owner", task_id: "somewhere-else" }) as never);
    const response = await f.call(`/${id}/revise`, { version: 1, shots: [0] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("片段素材不可用") });
    expect(f.store.revise).not.toHaveBeenCalled();
  });
  it("lets recovery reuse a kept clip owned by the segment task that made it", async () => {
    const f = made();
    Object.assign(f.project, { status: "failed", revision: undefined });
    f.service.db.getTask.mockResolvedValue({ id: "parent", type: "marketing.video", user_id: "owner", status: "failed",
      input: { projectId: id, draft: f.project.draft, generate_audio: true, marketingInputVersion: 3, modelId: "grok-imagine-video-1.5" } });
    f.store.reserve.mockResolvedValue("parent");
    expect((await f.call(`/${id}/generate`, { version: 1, retry: true })).status).toBe(202);
    expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, {}, true);
  });
});

describe("recorded review and publication requests", () => {
  it("requires a request identity and project version before calling the model", async () => {
    const f = fixture();
    for (const path of ["review", "publication"]) {
      const response = await f.app.request(`/api/marketing-videos/${id}/${path}`, { method: "POST", body: JSON.stringify({ locale: "zh", fillMissing: false }), headers: { "Content-Type": "application/json" } });
      expect(response.status).toBe(400);
    }
    expect(f.operations.begin).not.toHaveBeenCalled(); expect(f.service.marketingText).not.toHaveBeenCalled();
  });
  it("replays a saved outcome for a repeated request without another model call", async () => {
    const f = fixture();
    f.operations.begin.mockResolvedValueOnce({ fresh: false, operation: { id: "op", kind: "review", status: "succeeded", result: { review: { verdict: "pass", issues: [] } } } } as never);
    const response = await f.call(`/${id}/review`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, operation: { id: "op", status: "succeeded" } });
    expect(f.service.marketingText).not.toHaveBeenCalled();
    f.operations.begin.mockResolvedValueOnce({ fresh: false, operation: { id: "op", kind: "publication", status: "unknown" } } as never);
    expect((await f.call(`/${id}/publication`, { locale: "zh", fillMissing: false })).status).toBe(409);
    expect(f.service.marketingText).not.toHaveBeenCalled();
  });
  it("fills only fields missing from the frozen draft and records the publication", async () => {
    const f = fixture(); f.project.draft = MarketingDraftSchema.parse({ ...f.project.draft, publishTitle: "原标题" });
    f.service.marketingText.mockResolvedValueOnce({ publishTitle: "新标题", tags: "#咖啡" });
    expect((await f.call(`/${id}/publication`, { locale: "zh", fillMissing: true })).status).toBe(200);
    expect(f.operations.begin).toHaveBeenCalledWith("owner", expect.any(String), id, 1, "publication", { version: 1, locale: "zh", fillMissing: true });
    expect(f.operations.finish).toHaveBeenCalledWith("owner", expect.any(String), expect.objectContaining({ draft: expect.objectContaining({ publishTitle: "原标题", tags: "#咖啡" }) }));
    expect(f.service.marketingText).toHaveBeenCalledWith(expect.any(String), expect.any(String), "owner", undefined, expect.objectContaining({ onReceipt: expect.any(Function) }));
  });
  it("reports a result that no longer matches the draft as a conflict", async () => {
    const f = fixture();
    f.service.marketingText.mockResolvedValueOnce({ verdict: "pass", issues: [] });
    f.operations.finish.mockResolvedValueOnce({ id: "op", status: "conflict", result: {} } as never);
    expect((await f.call(`/${id}/review`, {})).status).toBe(409);
  });
});

describe("server reference image contract", () => {
  const generate = (f: ReturnType<typeof fixture>) => f.call(`/${id}/generate`, { version: 1, retry: false });
  function withImage(mime = "image/png") {
    const f = fixture(); f.project.draft.assets = { portrait: id };
    f.service.db.getAsset.mockImplementation(async () => ({ user_id: "owner", mime, size_bytes: 100, url: `/static/${id}`, original_name: "face.png" }) as never);
    return f;
  }
  it("checks the file signature and size against the Kling contract before reserving", async () => {
    process.env.MARKETING_VIDEO_MODEL = "kling-video-v3-omni";
    try {
      for (const info of [{ mime: "image/webp" as const, width: 800, height: 800 }, { mime: "image/png" as const, width: 200, height: 800 }, { mime: "image/png" as const, width: 2000, height: 600 }, null]) {
        const f = withImage();
        vi.mocked(readImageInfo).mockResolvedValueOnce(info);
        const response = await generate(f);
        expect(response.status).toBe(400);
        expect((await response.json() as { error: string }).error).toMatch(/^(当前视频模型的参考图|参考图)/);
        expect(f.store.reserve).not.toHaveBeenCalled(); expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
      }
      expect((await generate(withImage())).status).toBe(202);
    } finally { delete process.env.MARKETING_VIDEO_MODEL; }
  });
  it("accepts a real WebP for Grok but rejects an undecodable file", async () => {
    vi.mocked(readImageInfo).mockResolvedValueOnce({ mime: "image/webp", width: 64, height: 64 });
    expect((await generate(withImage("image/webp"))).status).toBe(202);
    vi.mocked(readImageInfo).mockResolvedValueOnce(null);
    expect((await generate(withImage())).status).toBe(400);
  });
});

describe("digital twin narration", () => {
  const twinItemId = "33333333-3333-4333-8333-333333333333";
  const shots = [0, 1].map(slot => ({ durationSec: 8, script: slot ? "第二句旁白" : "第一句旁白", visual: "门店", action: "展示", camera: "中景" }));
  const takes = [0, 1].map(slot => ({ slot, key: `key-${slot}`, storageKey: `${id}/${randomUUID()}.wav`, durationMs: 3000 }));
  function narrated(narrator: Partial<MarketingNarrator>) {
    const f = fixture("owner", narrator);
    Object.assign(f.project, { draft: MarketingDraftSchema.parse({ durationSec: 15, storyboard: shots, script: storyboardScript(shots), narration: { twinItemId } }), review: { verdict: "pass", issues: [] } });
    f.service.db.getAsset.mockResolvedValue({ user_id: "owner", mime: "image/png", size_bytes: 100 });
    return f;
  }
  it("freezes a take per shot and asks the clips for no speech, ignoring a voice sample", async () => {
    const frozen = vi.fn(async () => takes);
    const f = narrated({ frozen });
    const voiceId = randomUUID();
    f.project.draft.assets = { voice: voiceId };
    f.service.db.getAsset.mockResolvedValue({ user_id: "owner", mime: "audio/mpeg", size_bytes: 100, url: "/static/voice.mp3", type: "upload", is_private: true } as never);
    expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
    expect(frozen).toHaveBeenCalledWith("owner", id, f.project.draft, expect.arrayContaining([expect.objectContaining({ index: 1, script: "第二句旁白" })]));
    expect(f.store.reserve).toHaveBeenCalledWith("owner", id, 1, expect.objectContaining({ marketingInputVersion: 4, generate_audio: false, reference_audio: undefined, narration: takes, local_subtitles: true }), false);
  });
  it("blocks a captioned narrated video when this host cannot burn captions, but not an uncaptioned one", async () => {
    vi.mocked(mediaCapabilities).mockResolvedValue({ composition: true, subtitles: false });
    try {
      const f = narrated({ frozen: vi.fn(async () => takes) });
      const blocked = await f.call(`/${id}/generate`, { version: 1, retry: false });
      expect(blocked.status).toBe(503);
      expect(await blocked.json()).toMatchObject({ error: "当前环境不支持字幕，可关闭字幕后生成。" });
      expect(f.store.reserve).not.toHaveBeenCalled();
      f.project.draft.subtitles = false;
      expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(202);
    } finally { vi.mocked(mediaCapabilities).mockResolvedValue({ composition: true, subtitles: true }); }
  });
  it("refuses to submit clips before every shot has a fitting take", async () => {
    const f = narrated({ frozen: vi.fn(async () => { throw new MarketingError("请先生成全部分镜的数字分身配音并试听。", 409); }) });
    expect((await f.call(`/${id}/generate`, { version: 1, retry: false })).status).toBe(409);
    expect(f.store.reserve).not.toHaveBeenCalled();
  });
  it("synthesizes only for the saved version and rejects invalid shot choices", async () => {
    const synthesize = vi.fn(async () => ({ clips: [], error: "" }));
    const f = narrated({ synthesize });
    expect((await f.call(`/${id}/narration`, { version: 2 })).status).toBe(409);
    expect((await f.call(`/${id}/narration`, { version: 1, slots: [0.5] })).status).toBe(400);
    expect((await f.call(`/${id}/narration`, { version: 1, slots: [1] })).status).toBe(200);
    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledWith("owner", id, f.project.draft, expect.any(Array), [1]);
  });
  it("has no narration for a model-voiced draft", async () => {
    const f = fixture("owner", { status: vi.fn() });
    expect((await f.call(`/${id}/narration`)).status).toBe(400);
  });
  it("gives redone shots of a narrated video new takes and freezes them into the new job", async () => {
    const synthesize = vi.fn(async () => ({ clips: [], error: "" }));
    const frozen = vi.fn(async () => takes);
    const f = narrated({ synthesize, frozen });
    const draft = f.project.draft;
    Object.assign(f.project, { taskId: "parent", status: "succeeded", revision: { draft, modelId: "grok-imagine-video-1.5", reusable: [true, true] } });
    f.service.db.getTask.mockResolvedValue({ id: "parent", type: "marketing.video", user_id: "owner", status: "succeeded",
      input: { projectId: id, draft, generate_audio: false, narration: takes, marketingInputVersion: 4, modelId: "grok-imagine-video-1.5" } });
    f.store.segments.mockResolvedValue([0, 1].map(slot => ({ slot, task_id: `child-${slot}`, duration_sec: 8, script: shots[slot].script, output: { assetIds: [`clip-${slot}`] } })));
    f.service.db.getAsset.mockImplementation((async (assetId: string) => ({ user_id: "owner", task_id: assetId === "clip-0" ? "child-0" : "child-1" })) as never);
    Object.assign(f.store, { revise: vi.fn(async () => "revision") });
    expect((await f.call(`/${id}/revise`, { version: 1, shots: [1] })).status).toBe(202);
    expect(synthesize).toHaveBeenCalledOnce();
    expect((f.store as unknown as { revise: ReturnType<typeof vi.fn> }).revise).toHaveBeenCalledWith("owner", id, 1, "parent", [1], { narration: takes });
    // New voice settings or reworded lines without a redone shot: new takes, every clip kept.
    expect((await f.call(`/${id}/revise`, { version: 1, shots: [] })).status).toBe(202);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize).toHaveBeenLastCalledWith("owner", id, draft, expect.any(Array), [], { background: true, failedOnly: true });
    expect((f.store as unknown as { revise: ReturnType<typeof vi.fn> }).revise).toHaveBeenLastCalledWith("owner", id, 1, "parent", [], { narration: takes });
    // Takes still being made: no job yet, and the studio sends the same redo again once they stop.
    const revise = (f.store as unknown as { revise: ReturnType<typeof vi.fn> }).revise;
    synthesize.mockResolvedValueOnce({ clips: [{ slot: 0, status: "succeeded" }, { slot: 1, status: "running" }] as never, error: "" });
    const pending = await f.call(`/${id}/revise`, { version: 1, shots: [1] });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ narrationPending: true, clips: [{ slot: 0, status: "succeeded" }, { slot: 1, status: "running" }] });
    expect(revise).toHaveBeenCalledTimes(2);
    // A take that failed in the background gives its own reason.
    synthesize.mockResolvedValueOnce({ clips: [{ slot: 1, status: "failed", error: "模型账号余额不足或未开通语音合成。" }] as never, error: "" });
    const failed = await f.call(`/${id}/revise`, { version: 1, shots: [1] });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({ error: "模型账号余额不足或未开通语音合成。" });
    expect(revise).toHaveBeenCalledTimes(2);
    // The user confirms making the failed take again: only that shot is named, and only a failed take is redone.
    synthesize.mockResolvedValueOnce({ clips: [{ slot: 0, status: "succeeded" }, { slot: 1, status: "running" }] as never, error: "" });
    expect((await f.call(`/${id}/revise`, { version: 1, shots: [1], narrationRedo: [1] })).status).toBe(202);
    expect(synthesize).toHaveBeenLastCalledWith("owner", id, draft, expect.any(Array), [1], { background: true, failedOnly: true });
    for (const narrationRedo of [[1, 1], [0.5], "1"]) {
      expect((await f.call(`/${id}/revise`, { version: 1, shots: [1], narrationRedo })).status).toBe(400);
    }
  });
});
