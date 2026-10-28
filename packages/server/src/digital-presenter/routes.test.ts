import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PresenterDraftSchema } from "@lot-agent/core/digital-presenter";
import type { AgentService } from "../services/agent-service.js";
import { mediaCapabilities } from "../marketing-video/media.js";
import { marketingCopyModel } from "../marketing-video/copy-model.js";
import { createDigitalPresenterRoutes } from "./routes.js";
import type { PgPresenterStore } from "./repository.js";
import type { PresenterVoicer } from "./takes.js";

vi.mock("../marketing-video/media.js", () => ({ mediaCapabilities: vi.fn(async () => ({ composition: true, subtitles: true })), SUBTITLES_UNAVAILABLE: "字幕不可用", inspectMedia: vi.fn(), ownedAssetPath: vi.fn() }));

const ID = "11111111-1111-4111-8111-111111111111";
const takes = [{ slot: 0, text: "大家好，欢迎光临。", file: "a.wav", durationMs: 2000 }, { slot: 1, text: "今天有优惠。", file: "b.wav", durationMs: 1500 }];

function setup(project: Record<string, unknown> = {}, frozen: Record<string, unknown> = {}) {
  const p = { id: ID, version: 3, taskId: "task-1", status: "succeeded", progress: 100, draft: PresenterDraftSchema.parse({ script: "大家好，欢迎光临。今天有优惠。" }), updatedAt: "", ...project };
  const store = { get: vi.fn(async () => p), recompose: vi.fn(async (..._args: unknown[]) => "task-2") };
  const queue = { canResumePersisted: vi.fn(async () => true), deliverPersisted: vi.fn() };
  const service = { db: { pool: {}, getTask: vi.fn(async () => ({ id: "task-1", user_id: "owner", type: "digital-presenter.video",
    input: { presenterInputVersion: 1, projectId: ID, mode: "image", model: "wan2.2-s2v", takes, subtitles: true, draft: p.draft, ...frozen } })) }, jobQueue: queue };
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
  app.route("/api/digital-presenters", createDigitalPresenterRoutes(service as unknown as AgentService, "/tmp", {} as PresenterVoicer, store as unknown as PgPresenterStore));
  const post = (captions: unknown, version = 3) => app.request(`/api/digital-presenters/${ID}/captions`,
    { method: "POST", body: JSON.stringify({ version, captions }), headers: { "Content-Type": "application/json" } });
  return { store, queue, post };
}

describe("POST /:id/captions", () => {
  beforeEach(() => vi.mocked(mediaCapabilities).mockResolvedValue({ composition: true, subtitles: true }));

  it("starts a recompose job with the changed captions", async () => {
    const f = setup();
    const captions = { size: "large", position: "medium", offsetSec: 0.2, shots: [{ script: takes[0].text, lines: ["大家好", "欢迎光临"], offsetSec: 0 }] };
    const response = await f.post(captions);
    expect(response.status).toBe(202);
    expect(f.store.recompose).toHaveBeenCalledWith("owner", ID, 3, "task-1", expect.objectContaining({ takes, subtitles: true, captions }), captions);
    const input = f.store.recompose.mock.calls[0][4] as Record<string, unknown>;
    expect(input).not.toHaveProperty("draft");
    expect(input).not.toHaveProperty("projectId");
    expect(f.queue.deliverPersisted).toHaveBeenCalledWith("task-2", "digital-presenter.video");
  });

  it("rejects changed words, unchanged settings, unfinished and caption-less videos", async () => {
    expect((await setup().post({ shots: [{ script: takes[0].text, lines: ["大家好", "欢迎来到"] }] })).status).toBe(400);
    expect((await setup({}, { captions: { size: "large" } }).post({ size: "large" })).status).toBe(409);
    expect((await setup().post({})).status).toBe(409);
    expect((await setup({ status: "running" }).post({ size: "large" })).status).toBe(409);
    expect((await setup({}, { subtitles: undefined }).post({ size: "large" })).status).toBe(409);
    expect((await setup().post({ size: "large" }, 2)).status).toBe(409);
  });

  it("checks subtitle support before starting", async () => {
    vi.mocked(mediaCapabilities).mockResolvedValue({ composition: true, subtitles: false });
    const f = setup();
    expect((await f.post({ size: "large" })).status).toBe(503);
    expect(f.store.recompose).not.toHaveBeenCalled();
  });
});

describe("POST /script", () => {
  const write = (reply: unknown) => {
    const marketingText = vi.fn(async (..._args: unknown[]) => reply);
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
    const service = { db: { pool: {} }, jobQueue: {}, marketingText };
    app.route("/api/digital-presenters", createDigitalPresenterRoutes(service as unknown as AgentService, "/tmp", {} as PresenterVoicer, {} as PgPresenterStore));
    const response = app.request("/api/digital-presenters/script",
      { method: "POST", body: JSON.stringify({ topic: "咖啡店开业", durationSec: 30, locale: "zh" }), headers: { "Content-Type": "application/json" } });
    return { marketingText, response };
  };
  beforeEach(() => marketingCopyModel.reset());

  it("writes with the current marketing copy model", async () => {
    const f = write({ script: "欢迎光临。" });
    expect(await (await f.response).json()).toEqual({ script: "欢迎光临。" });
    expect(f.marketingText.mock.calls[0][4]).toEqual({ upstreamBilling: true, model: marketingCopyModel.models[0] });
    expect(marketingCopyModel.current()).toBe(marketingCopyModel.models[0]);
  });
  it("switches the copy model like marketing copy when the reply has no script", async () => {
    expect((await write({ text: "欢迎光临。" }).response).status).toBe(409);
    expect(marketingCopyModel.current()).toBe(marketingCopyModel.models[1]);
  });
});
