import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createGenerationRoutes } from "./conversations.js";
import { PosterLibrary } from "../generation/poster-library.js";
import { createDigitalEmployeeExtension } from "../digital-employee/agent.js";
import { registerAgentExtension } from "../services/agent-extensions.js";

registerAgentExtension(createDigitalEmployeeExtension());

function fakeService() {
  const messages: any[] = [];
  return {
    messages,
    db: {
      claimConversationRun: vi.fn(async () => true),
      releaseConversationRun: vi.fn(async () => {}),
      getMessages: vi.fn(async () => messages),
      getConversation: vi.fn(async () => ({ id: "c1", user_id: "u1" })),
      getUploadByStorageKey: vi.fn(async (storageKey: string) => ({
        type: "upload", storage_key: storageKey, user_id: "u1", mime: "image/png", is_private: false,
      })),
      getGeneratedByStorageKey: vi.fn(async (storageKey: string) => ({
        type: "image", storage_key: storageKey, user_id: "u1", mime: "image/png", is_private: false,
      })),
      getTask: vi.fn(async () => null),
      findOriginalImageTask: vi.fn(async () => null),
      addMessage: vi.fn(async (id: string, _cid: string, role: string, content: string, opts: any) => {
        messages.push({ id, role, content, ...opts });
      }),
      updateMessageGeneration: vi.fn(async (id: string, patch: any) => { const message = messages.find(m => m.id === id); if (message) Object.assign(message, patch); }),
      getGenerationMessage: vi.fn(async () => ({
        status: "download_failed",
        metadata: {
          kind: "generation",
          mediaType: "video",
          status: "download_failed",
          sourceUrl: "https://vendor.example/out.mp4",
          prompt: "菊花",
          settings: { durationSec: 5 },
        },
      })),
      resetGenerationForRedownload: vi.fn(async () => true),
    },
    usageMeter: { checkQuota: vi.fn(async () => ({ ok: true })) },
    modelRegistry: { getConfig: vi.fn(() => ({ unitPrice: 0.04 })) },
    generationSupportsProgress: { image: false, video: true },
    jobQueue: { enqueue: vi.fn(async () => "task-1") },
    generateTitle: vi.fn(async () => "菊花特写"),
  } as any;
}

function app(service: any, posterLibrary?: PosterLibrary) {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  a.route("/conversations", createGenerationRoutes(service, { posterLibrary }));
  return a;
}

describe("POST /conversations/:id/generations", () => {
  it("estimates dynamic video models with video catalog pricing and returns a quota code", async () => {
    const service = fakeService();
    service.modelRegistry.getConfig.mockReturnValue(undefined);
    service.modelCatalog = { providerMap: {}, defaultProvider: { video: "openai-video" }, pricing: {}, defaultPricing: { video: { inputPrice: 0, outputPrice: 0, unitPrice: 0.7 } } };
    service.usageMeter.checkQuota.mockResolvedValue({ ok: false, reason: "daily limit", code: "DAILY_LIMIT_EXCEEDED" });
    const response = await app(service).request("/conversations/c1/generations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "视频", mediaType: "video", model: "doubao-seedance-2-5", settings: { durationSec: 10 } }),
    });
    expect(service.usageMeter.checkQuota).toHaveBeenCalledWith("u1", 7);
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "DAILY_LIMIT_EXCEEDED", estimatedCost: 7 });
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });
  it("returns the queued task before a slow title model finishes", async () => {
    const service = fakeService();
    let finish!: (title: string) => void;
    service.generateTitle = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    let responded = false;
    const response = Promise.resolve(app(service).request("/conversations/c1/generations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image" }),
    })).then((r) => { responded = true; return r; });
    try {
      await vi.waitFor(() => expect(responded).toBe(true), { timeout: 200 });
      expect((await response).status).toBe(202);
    } finally { finish("菊花特写"); await response; }
  });
  it("persists user + assistant messages and enqueues a task", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", settings: { size: "1024x1024", n: 1 } }),
    });
    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.taskId).toBe("task-1");
    expect(body.userMessage.content).toBe("菊花");
    expect(body.assistantMessage.status).toBe("generating");
    // The synchronous image provider reports no progress, so the metadata tells
    // the client not to show a percentage.
    expect(body.assistantMessage.metadata.supportsProgress).toBe(false);
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({ prompt: "菊花", conversationId: "c1", assistantMessageId: body.assistantMessage.id, size: "1024x1024", quality: "auto" }),
      "u1"
    );
    expect(service.messages).toHaveLength(2);
  });

  it("auto-generates the conversation title from the prompt", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", settings: { n: 1 } }),
    });
    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(service.generateTitle).toHaveBeenCalledWith("c1", "菊花", [], {
      userId: "u1",
    });
    expect(body.title).toBeUndefined(); // Title is persisted asynchronously, not awaited by submission.
  });

  it("marks digital-employee generation titles as user-TokenHub-only", async () => {
    const service = fakeService();
    service.db.getConversation = vi.fn(async () => ({
      id: "c1", user_id: "u1", agent_id: "digital_employee",
    }));
    await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "营销海报", mediaType: "image", settings: { n: 1 } }),
    });
    expect(service.generateTitle).toHaveBeenCalledWith("c1", "营销海报", [], {
      userId: "u1",
      agentId: "digital_employee",
    });
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({ requireUserModelKey: true }),
      "u1"
    );
  });

  it("404s when the conversation belongs to another user", async () => {
    const service = fakeService();
    service.db.getConversation = vi.fn(async () => ({ id: "c1", user_id: "other" }));
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", mediaType: "image" }),
    });
    expect(res.status).toBe(404);
  });

  it("ignores identity fields smuggled through settings — server values win", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "菊花",
        mediaType: "image",
        settings: {
          n: 1,
          assistantMessageId: "victim-message",
          conversationId: "victim-conversation",
          userId: "victim-user",
        },
      }),
    });
    expect(res.status).toBe(202);
    const body: any = await res.json();
    const input = service.jobQueue.enqueue.mock.calls[0][1];
    expect(input.assistantMessageId).toBe(body.assistantMessage.id);
    expect(input.conversationId).toBe("c1");
    expect(input.userId).toBeUndefined();
    // The persisted metadata must not echo the forged identity fields either.
    expect(body.assistantMessage.metadata.settings).toEqual({ n: 1, quality: "auto" });
  });

  it("threads media (reference images) into the enqueued input", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", settings: { size: "1024x1024" }, media: [{ type: "reference_image", url: "/static/assets/x.png" }] }),
    });
    expect(res.status).toBe(202);
    await res.json();
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({ media: [{ type: "reference_image", url: "/static/assets/x.png" }], size: "1024x1024" }),
      "u1"
    );
  });

  it("threads two image-edit references into the enqueued input", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "以第一张图为主体，参考第二张图的水彩风格",
        mediaType: "image",
        media: [
          { type: "reference_image", url: "/static/uploads/a.png" },
          { type: "reference_image", url: "/static/uploads/b.png" },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({
        media: [
          { type: "reference_image", url: "/static/uploads/a.png" },
          { type: "reference_image", url: "/static/uploads/b.png" },
        ],
      }),
      "u1"
    );
  });

  it("accepts five image-edit references", async () => {
    const service = fakeService();
    const media = Array.from({ length: 5 }, (_, i) => ({
      type: "reference_image",
      url: `/static/uploads/${i}.png`,
    }));
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", media }),
    });
    expect(res.status).toBe(202);
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({ media }),
      "u1"
    );
  });

  it("rejects image edits with more than five reference images", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "菊花",
        mediaType: "image",
        media: Array.from({ length: 6 }, (_, i) => ({
          type: "reference_image",
          url: `/static/uploads/${i}.png`,
        })),
      }),
    });
    expect(res.status).toBe(400);
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("threads video references and frames into the enqueued input", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "镜头推进",
        mediaType: "video",
        input_reference: ["/static/uploads/a.png", "/static/uploads/b.png"],
        reference_video: ["/static/uploads/r1.mp4", "/static/uploads/r2.mp4"],
        reference_audio: ["/static/uploads/a1.mp3"],
        generate_audio: true,
        first_frame: "/static/uploads/first.png",
        last_frame: "/static/uploads/last.png",
      }),
    });
    expect(res.status).toBe(202);
    await res.json();
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({
        input_reference: ["/static/uploads/a.png", "/static/uploads/b.png"],
        reference_video: ["/static/uploads/r1.mp4", "/static/uploads/r2.mp4"],
        reference_audio: ["/static/uploads/a1.mp3"],
        first_frame: "/static/uploads/first.png",
        last_frame: "/static/uploads/last.png",
      }),
      "u1"
    );
  });

  it.each(["480p", "720p", "1080p"])("preserves video resolution %s in the queued task", async (resolution) => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "视频", mediaType: "video", settings: { resolution, ratio: "1:1" } }),
    });
    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.assistantMessage.metadata.settings).toMatchObject({ resolution, ratio: "1:1" });
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith("video.generate", expect.objectContaining({ resolution, ratio: "1:1" }), "u1");
  });

  it("defaults video generation audio to false when no reference audio is supplied", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "无声视频", mediaType: "video", settings: {} }),
    });
    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.assistantMessage.metadata.settings.generate_audio).toBe(false);
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({ generate_audio: false }),
      "u1",
    );
  });

  it("forces video generation audio on when reference audio is supplied", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "参考音频视频",
        mediaType: "video",
        settings: { generate_audio: false },
        reference_audio: "/static/uploads/reference.mp3",
      }),
    });
    expect(res.status).toBe(202);
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({ reference_audio: "/static/uploads/reference.mp3", generate_audio: true }),
      "u1",
    );
  });

  it("threads image quality into the enqueued input", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "菊花",
        mediaType: "image",
        settings: { size: "1536x1024", quality: "high" },
      }),
    });
    expect(res.status).toBe(202);
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({ size: "1536x1024", quality: "high" }),
      "u1"
    );
  });

  it("rejects the old 16:9 1024x576 size below the pixel budget", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "菊花",
        mediaType: "image",
        settings: { size: "1024x576" },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "分辨率过低，宽×高不能小于 655360 像素" });
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects an image size whose aspect ratio exceeds 1:3 or 3:1", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "菊花",
        mediaType: "image",
        settings: { size: "512x2048" },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "宽高比不能超过 1:3 或 3:1" });
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("maps mini program slots to their per-tier vendor models", async () => {
    const service = fakeService();
    const fast = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lot-Client": "miniprogram" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", model: "1" }),
    });
    const high = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lot-Client": "miniprogram" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", model: "2" }),
    });
    const standard = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lot-Client": "miniprogram" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", model: "3" }),
    });
    expect(fast.status).toBe(202);
    expect(high.status).toBe(202);
    expect(standard.status).toBe(202);
    expect(service.jobQueue.enqueue.mock.calls[0][1].modelId).toBe("doubao-seedream-5-0-pro");
    expect(service.jobQueue.enqueue.mock.calls[1][1].modelId).toBe("gpt-image-2.5-sunburst");
    expect(service.jobQueue.enqueue.mock.calls[2][1].modelId).toBe("gpt-image-2.5-flare");
    expect(service.generateTitle).toHaveBeenCalledWith("c1", "菊花", [], {
      userId: "u1",
      modelId: "deepseek-v4.1-flash",
    });
  });

  it("downshifts mini program sizes by quality tier before validation", async () => {
    const service = fakeService();
    const post = (model: string, size: string) =>
      app(service).request("/conversations/c1/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Lot-Client": "miniprogram" },
        body: JSON.stringify({ prompt: "菊花", mediaType: "image", model, settings: { size } }),
      });

    // 快速: every ratio drops to the smallest Seedream-legal size for the ratio.
    await post("1", "1024x1024");
    expect(service.jobQueue.enqueue.mock.calls.at(-1)![1].size).toBe("960x960");
    await post("1", "1920x1088");
    expect(service.jobQueue.enqueue.mock.calls.at(-1)![1].size).toBe("1280x720");

    // 自动/标准: only the wide ratios drop.
    await post("3", "1920x1088");
    expect(service.jobQueue.enqueue.mock.calls.at(-1)![1].size).toBe("1536x864");
    await post("3", "1088x1920");
    expect(service.jobQueue.enqueue.mock.calls.at(-1)![1].size).toBe("864x1536");
    await post("3", "1024x1024");
    expect(service.jobQueue.enqueue.mock.calls.at(-1)![1].size).toBe("1024x1024");

    // 高清: untouched.
    await post("2", "1920x1088");
    expect(service.jobQueue.enqueue.mock.calls.at(-1)![1].size).toBe("1920x1088");
  });

  it("does not downshift sizes for non-mini-program models", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "菊花",
        mediaType: "image",
        model: "gpt-image-2",
        settings: { size: "1920x1088" },
      }),
    });
    expect(res.status).toBe(202);
    expect(service.jobQueue.enqueue.mock.calls.at(-1)![1].size).toBe("1920x1088");
  });

  it("falls back to gpt-image-2 when the preferred model is missing from the catalog", async () => {
    const service = fakeService();
    service.db.getUserApiKey = vi.fn(async () => "sk");
    service.getUserModelCatalog = vi.fn(async () => ({
      llm: [],
      image: [{ id: "gpt-image-2" }, { id: "doubao-seedream-5-0-pro" }],
      video: [],
    }));
    // Slot 2 (高清 → sunburst) is missing → shared backup gpt-image-2.
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", model: "2" }),
    });
    expect(res.status).toBe(202);
    expect(service.jobQueue.enqueue.mock.calls[0][1].modelId).toBe("gpt-image-2");

    // Slot 1 (快速 → seedream) resolves directly when present.
    await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", model: "1" }),
    });
    expect(service.jobQueue.enqueue.mock.calls[1][1].modelId).toBe("doubao-seedream-5-0-pro");
  });

  it("rejects a custom size on gpt-image 1.5", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "菊花",
        mediaType: "image",
        model: "gpt-image-1.5",
        settings: { size: "1280x720" },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "当前模型不支持自定义分辨率" });
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects video references over their limits", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", mediaType: "video", reference_video: ["1", "2", "3", "4"] }),
    });
    expect(res.status).toBe(400);
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });
});

describe("POST /conversations/:id/generations/:messageId/redownload", () => {
  it("reopens the message and enqueues a download-only retry (no vendor re-billing)", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations/m1/redownload", { method: "POST" });
    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.taskId).toBe("task-1");
    expect(service.db.resetGenerationForRedownload).toHaveBeenCalledWith("m1", { conversationId: "c1", userId: "u1" });
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "generation.redownload",
      expect.objectContaining({
        mediaType: "video",
        sourceUrl: "https://vendor.example/out.mp4",
        conversationId: "c1",
        assistantMessageId: "m1",
        durationSec: 5,
      }),
      "u1"
    );
  });

  it("keeps the image type through the retry so the card still names each image", async () => {
    const service = fakeService();
    service.db.getGenerationMessage = vi.fn(async () => ({
      status: "download_failed",
      metadata: {
        kind: "generation", mediaType: "image", status: "download_failed", scene: "product_set",
        sourceUrl: "https://vendor.example/1.png", sourceUrls: ["https://vendor.example/1.png", "https://vendor.example/2.png"], prompt: "保温杯",
      },
    }));
    const res = await app(service).request("/conversations/c1/generations/m1/redownload", { method: "POST" });
    expect(res.status).toBe(202);
    expect(service.jobQueue.enqueue.mock.calls[0][1]).toMatchObject({ scene: "product_set", assistantMessageId: "m1" });
    expect(service.db.updateMessageGeneration.mock.calls[0][1].metadata).toMatchObject({ scene: "product_set", status: "generating" });
  });

  it("404s when the message is not found / not owned by the user", async () => {
    const service = fakeService();
    service.db.getGenerationMessage = vi.fn(async () => null);
    const res = await app(service).request("/conversations/c1/generations/m1/redownload", { method: "POST" });
    expect(res.status).toBe(404);
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("409s when the message is not in a download_failed state", async () => {
    const service = fakeService();
    service.db.getGenerationMessage = vi.fn(async () => ({
      status: "completed",
      metadata: { kind: "generation", mediaType: "video", status: "completed", assets: [{ url: "/x", mime: "video/mp4" }] },
    }));
    const res = await app(service).request("/conversations/c1/generations/m1/redownload", { method: "POST" });
    expect(res.status).toBe(409);
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("409s (no double enqueue) when the reopen loses the race to a concurrent retry", async () => {
    const service = fakeService();
    service.db.resetGenerationForRedownload = vi.fn(async () => false);
    const res = await app(service).request("/conversations/c1/generations/m1/redownload", { method: "POST" });
    expect(res.status).toBe(409);
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });
});

describe.each(["miniprogram", "marketing_video"])("%s video duplicate protection", (client) => {
  const scenarioService = () => {
    const service = fakeService();
    service.db.getConversation.mockResolvedValue({ id: "c1", user_id: "u1", agent_id: client === "marketing_video" ? "marketing_video" : "video" });
    return service;
  };
  const submit = (a: ReturnType<typeof app>) => a.request("/conversations/c1/generations", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Lot-Client": client === "miniprogram" ? "miniprogram" : "web" },
    body: JSON.stringify({ prompt: "视频", mediaType: "video" }),
  });
  it("replays an existing task without enqueueing or checking quota again", async () => {
    const service = scenarioService(); const a = app(service);
    expect((await submit(a)).status).toBe(202);
    const replay = await submit(a);
    expect(replay.status).toBe(202); expect((await replay.json() as { taskId: string }).taskId).toBe("task-1");
    expect(service.jobQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(service.usageMeter.checkQuota).toHaveBeenCalledTimes(1);
    expect(service.db.releaseConversationRun).toHaveBeenCalledTimes(2);
  });
  it("rejects a concurrent submission before any paid work", async () => {
    const service = scenarioService(); service.db.claimConversationRun.mockResolvedValue(false);
    expect((await submit(app(service))).status).toBe(409);
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
    expect(service.db.releaseConversationRun).not.toHaveBeenCalled();
  });
  it("serializes two concurrent requests through the database lease", async () => {
    const service = scenarioService(); let claimed = false;
    service.db.claimConversationRun.mockImplementation(async () => {
      if (claimed) return false;
      claimed = true; return true;
    });
    service.db.releaseConversationRun.mockImplementation(async () => { claimed = false; });
    const a = app(service);
    const responses = await Promise.all([submit(a), submit(a)]);
    expect(responses.map(r => r.status).sort()).toEqual([202, 409]);
    expect(service.jobQueue.enqueue).toHaveBeenCalledTimes(1);
  });
  it("releases the lease after a quota rejection so a funded user can submit", async () => {
    const service = scenarioService(); service.usageMeter.checkQuota.mockResolvedValueOnce({ ok: false, reason: "积分不足" });
    const a = app(service);
    expect((await submit(a)).status).toBe(402);
    expect(service.db.releaseConversationRun).toHaveBeenCalledTimes(1);
    expect((await submit(a)).status).toBe(202);
    expect(service.jobQueue.enqueue).toHaveBeenCalledTimes(1);
  });
  it("never re-enqueues when the first enqueue result was lost", async () => {
    const service = scenarioService(); service.jobQueue.enqueue.mockRejectedValue(new Error("lost response"));
    const a = app(service); a.onError(() => new Response("unavailable", { status: 500 }));
    expect((await submit(a)).status).toBe(500);
    expect((await submit(a)).status).toBe(409);
    expect(service.jobQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(service.db.releaseConversationRun).toHaveBeenCalledTimes(2);
  });
});


it.each([undefined, "doubao-seedance-2-5"])("fixes marketing video generation and pricing to Grok regardless of requested model %s", async (model) => {
  const service = fakeService();
  service.db.getConversation.mockResolvedValue({ id: "c1", user_id: "u1", agent_id: "marketing_video" });
  const res = await app(service).request("/conversations/c1/generations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "店铺介绍", mediaType: "video", model, settings: { quality: "1080p", durationSec: 5 } }),
  });
  expect(res.status).toBe(202);
  expect(service.modelRegistry.getConfig).toHaveBeenCalledWith("grok-imagine-video-1.5");
  expect(service.jobQueue.enqueue).toHaveBeenCalledWith("video.generate", expect.objectContaining({ modelId: "grok-imagine-video-1.5", quality: "1080p" }), "u1");
  expect(service.messages.find((message: { role: string }) => message.role === "assistant").model).toBe("grok-imagine-video-1.5");
});

it.each([
  [{ settings: { quality: "1080p" }, input_reference: ["https://cdn.example.com/a.png"] }, "720p"],
  [{ settings: { size: "1920x1080" }, reference_video: "https://cdn.example.com/a.mp4" }, "720p"],
  [{ settings: { quality: "720p" }, reference_video: "https://cdn.example.com/a.mp4", reference_audio: ["https://cdn.example.com/a.wav"] }, "参考视频"],
  [{ settings: { quality: "720p" }, reference_video: "https://cdn.example.com/a.mp4", first_frame: "https://cdn.example.com/f.png" }, "参考视频"],
  [{ settings: { quality: "720p" }, reference_video: ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"] }, "1 段"],
  [{ settings: { quality: "720p", durationSec: 10 }, reference_video: "https://cdn.example.com/a.mp4" }, "8 秒"],
])("rejects Grok reference combinations before billing %#", async (extra, message) => {
  const service = fakeService();
  const res = await app(service).request("/conversations/c1/generations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "店铺介绍", mediaType: "video", model: "grok-imagine-video-1.5", ...extra }),
  });
  expect(res.status).toBe(400);
  expect((await res.json() as { error: string }).error).toContain(message);
  expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
});

it("allows Grok 1080p with only a first frame", async () => {
  const service = fakeService();
  const res = await app(service).request("/conversations/c1/generations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "店铺介绍", mediaType: "video", model: "grok-imagine-video-1.5", settings: { quality: "1080p" }, first_frame: "https://cdn.example.com/f.png" }),
  });
  expect(res.status).toBe(202);
});


it.each([16, 60, -1, 0, 3, 15.5, "15", null])("rejects invalid marketing video duration %s before billing or enqueueing", async (durationSec) => {
  const service = fakeService();
  service.db.getConversation.mockResolvedValue({ id: "c1", user_id: "u1", agent_id: "marketing_video" });
  const res = await app(service).request("/conversations/c1/generations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "店铺介绍", mediaType: "video", settings: { durationSec } }),
  });
  expect(res.status).toBe(400);
  expect(service.usageMeter.checkQuota).not.toHaveBeenCalled();
  expect(service.db.addMessage).not.toHaveBeenCalled();
  expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  expect(service.db.releaseConversationRun).toHaveBeenCalledTimes(1);
});

it.each([4, 15])("accepts marketing video duration boundary %s", async (durationSec) => {
  const service = fakeService();
  service.db.getConversation.mockResolvedValue({ id: "c1", user_id: "u1", agent_id: "marketing_video" });
  const res = await app(service).request("/conversations/c1/generations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "店铺介绍", mediaType: "video", settings: { durationSec } }),
  });
  expect(res.status).toBe(202);
  expect(service.jobQueue.enqueue).toHaveBeenCalledWith("video.generate", expect.objectContaining({ durationSec }), "u1");
});

describe("POST /conversations/:id/generations image scenes", () => {
  const send = (service: any, body: Record<string, unknown>, library?: PosterLibrary) => app(service, library).request("/conversations/c1/generations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaType: "image", settings: { resolution: "1K", ratio: "1:1", n: 3 }, ...body }),
  });

  it("returns the scene check's reason and sends nothing when the request does not fit", async () => {
    const service = fakeService();
    service.imageSceneText = vi.fn(async () => '{"fits": false, "message": "这是风景，不是商品。可以试试：蓝牙音箱白底图"}');
    const res = await send(service, { prompt: "海边日落", scene: "white_background" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "这是风景，不是商品。可以试试：蓝牙音箱白底图", code: "IMAGE_SCENE_MISMATCH" });
    expect(service.db.addMessage).not.toHaveBeenCalled();
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("does not submit an image when the scene check fails", async () => {
    const service = fakeService();
    service.imageSceneText = vi.fn(async () => "not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await send(service, { prompt: "保温杯", scene: "product_set" });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "IMAGE_SCENE_UNAVAILABLE" });
      expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("queues one rewritten prompt per set image and keeps the user's text on the card", async () => {
    const service = fakeService();
    service.imageSceneText = vi.fn(async () => '{"fits": true, "prompts": ["cover", "points", "scene"]}');
    const res = await send(service, { prompt: "保温杯，12 小时保温", scene: "product_set", media: [{ type: "reference_image", url: "/static/uploads/cup.png" }] });
    expect(res.status).toBe(202);
    const [system, user] = service.imageSceneText.mock.calls[0];
    expect(system).toContain("1 reference image(s)");
    expect(user).toBe("保温杯，12 小时保温");
    const input = service.jobQueue.enqueue.mock.calls[0][1];
    expect(input).toMatchObject({ prompt: "cover", prompts: ["cover", "points", "scene"], n: 3, scene: "product_set", displayPrompt: "保温杯，12 小时保温" });
    expect((await res.json() as any).assistantMessage.metadata).toMatchObject({ prompt: "保温杯，12 小时保温", scene: "product_set" });
  });

  it("leaves free creation untouched", async () => {
    const service = fakeService();
    service.imageSceneText = vi.fn();
    const res = await send(service, { prompt: "菊花" });
    expect(res.status).toBe(202);
    expect(service.imageSceneText).not.toHaveBeenCalled();
    expect(service.jobQueue.enqueue.mock.calls[0][1]).toMatchObject({ prompt: "菊花" });
    expect(service.jobQueue.enqueue.mock.calls[0][1].prompts).toBeUndefined();
  });

  it("asks for a product photo before checking or sending a 换场景 request", async () => {
    const service = fakeService();
    service.imageSceneText = vi.fn();
    const res = await send(service, { prompt: "放在海边", scene: "product_scene" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "IMAGE_SCENE_NEEDS_PRODUCT" });
    expect(service.imageSceneText).not.toHaveBeenCalled();
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
    service.imageSceneText = vi.fn(async () => '{"fits": true, "prompts": ["the cup on a beach"]}');
    const ok = await send(service, { prompt: "放在海边", scene: "product_scene", media: [{ type: "reference_image", url: "/static/uploads/cup.png" }] });
    expect(ok.status).toBe(202);
    expect(service.jobQueue.enqueue.mock.calls[0][1]).toMatchObject({ prompt: "the cup on a beach", scene: "product_scene" });
  });

  it("rejects an unknown scene", async () => {
    const res = await send(fakeService(), { prompt: "菊花", scene: "poster" });
    expect(res.status).toBe(400);
  });

  it("uses a catalog design and owned brand photos and rejects untrusted references before enqueueing", async () => {
    const category = "家居日用";
    const posterReference = { category, filename: "tea.png" };
    const library = new PosterLibrary(async () => `品类,商品名,图片本地路径\n${category},茶壶,/workspace/posters/${category}/tea.png`);
    await library.refresh();
    const service = fakeService();
    service.imageSceneText = vi.fn();
    service.db.getUploadByStorageKey = vi.fn(async (key: string) => ({
      user_id: key === "mine.png" ? "u1" : "u2", type: "upload", storage_key: key, mime: "image/png", url: `/static/uploads/${key}`,
    }));
    const input = { prompt: "青山茶壶，手工釉色", scene: "poster_remix" };
    const refs = (url: string) => [{ type: "reference_image", url }];
    for (const [extra, code] of [
      [{}, "IMAGE_POSTER_REFERENCE_REQUIRED"],
      [{ posterReference: { ...posterReference, filename: "unlisted.png" } }, "IMAGE_POSTER_REFERENCE_UNAVAILABLE"],
      [{ posterReference, media: refs("/static/uploads/other.png") }, "IMAGE_POSTER_PRODUCT_UNAVAILABLE"],
      [{ posterReference, media: refs("https://example.com/brand.png") }, "IMAGE_POSTER_PRODUCT_UNAVAILABLE"],
    ] as const) {
      const response = await send(service, { ...input, ...extra }, library);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
    expect(service.db.addMessage).not.toHaveBeenCalled();

    const media = refs("/static/uploads/mine.png");
    const response = await send(service, { ...input, posterReference, media }, library);
    expect(response.status).toBe(202);
    expect(service.imageSceneText).not.toHaveBeenCalled();
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith("image.generate", expect.objectContaining({
      scene: "poster_remix", media, displayPrompt: input.prompt, n: 3,
      posterReference: expect.objectContaining({ ...posterReference, revision: expect.any(String) }),
      prompt: expect.stringContaining(input.prompt),
    }), "u1");
    expect(service.jobQueue.enqueue.mock.calls[0][1].prompt).toMatch(/Image 1 is the design reference.*\nImages 2 onward/);
  });
});

describe("POST /conversations/:id/generations/:messageId/compose", () => {
  async function png(background: string): Promise<Buffer> {
    const { default: sharp } = await import("sharp");
    return sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toBuffer();
  }
  async function setup(metadata: Record<string, unknown> = {}) {
    const service = fakeService();
    const files = new Map<string, Buffer>([["a.png", await png("#ff0000")], ["b.png", await png("#0000ff")]]);
    const meta: Record<string, unknown> = {
      kind: "generation", mediaType: "image", status: "completed", taskId: "task-1", scene: "main_images",
      assets: [{ url: "/static/assets/a.png", mime: "image/png" }, { url: "/static/assets/b.png", mime: "image/png" }],
      ...metadata,
    };
    service.db.getGenerationMessage = vi.fn(async () => ({ status: "completed", metadata: meta }));
    service.db.getGeneratedByStorageKey = vi.fn(async (key: string) => ({ user_id: key === "other.png" ? "u2" : "u1", storage_key: key }));
    service.db.createAsset = vi.fn(async () => {});
    service.db.appendGenerationComposite = vi.fn(async () => true);
    const assets = {
      exists: vi.fn(async (key: string) => files.has(key)),
      get: vi.fn(async (key: string) => files.get(key)!),
      put: vi.fn(async ({ key }: { key: string }) => ({ url: `/static/assets/${key}` })),
    };
    const a = new Hono<{ Variables: { userId: string } }>();
    a.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
    a.route("/conversations", createGenerationRoutes(service, { assets: assets as any }));
    const compose = (body: unknown) => a.request("/conversations/c1/generations/m1/compose", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { service, assets, compose };
  }

  it("stores one joined picture as the user's image and lists it on the message", async () => {
    const { service, assets, compose } = await setup();
    const res = await compose({ layout: "vertical", gap: false });
    expect(res.status).toBe(200);
    const { composite } = await res.json() as any;
    expect(composite).toMatchObject({ mime: "image/jpeg", layout: "vertical", gap: false });
    expect(composite.url).toMatch(/^\/static\/assets\/[0-9a-f-]+\.jpg$/);
    expect(assets.put).toHaveBeenCalledTimes(1);
    expect(service.db.createAsset).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1", type: "image", mime: "image/jpeg", taskId: "task-1", width: 32, height: 64,
    }));
    expect(service.db.appendGenerationComposite).toHaveBeenCalledWith("m1", composite, { conversationId: "c1", userId: "u1" });
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
    expect(service.usageMeter.checkQuota).not.toHaveBeenCalled();
  });

  it("returns the stored picture when the same layout is asked for again", async () => {
    const stored = { url: "/static/assets/done.jpg", mime: "image/jpeg", layout: "grid", gap: true };
    const { assets, compose } = await setup({ composites: [stored] });
    const res = await compose({ layout: "grid", gap: true });
    expect(await res.json()).toEqual({ composite: stored });
    expect(assets.put).not.toHaveBeenCalled();
  });

  it("refuses images that are not this user's stored output", async () => {
    const foreign = await setup({ assets: [{ url: "/static/assets/a.png", mime: "image/png" }, { url: "/static/assets/other.png", mime: "image/png" }] });
    expect((await foreign.compose({ layout: "vertical" })).status).toBe(409);
    const external = await setup({ assets: [{ url: "/static/assets/a.png", mime: "image/png" }, { url: "https://vendor.example/b.png", mime: "image/png" }] });
    expect((await external.compose({ layout: "vertical" })).status).toBe(409);
    expect(external.assets.get).not.toHaveBeenCalledWith(expect.stringContaining("vendor"));
    expect(foreign.assets.put).not.toHaveBeenCalled();
  });

  it("rejects unknown layouts, layouts that need more images, and unfinished or video generations", async () => {
    const ready = await setup();
    expect((await ready.compose({ layout: "spiral" })).status).toBe(400);
    expect((await ready.compose({ layout: "hero" })).status).toBe(400);
    expect((await (await setup({ status: "generating" })).compose({ layout: "vertical" })).status).toBe(409);
    expect((await (await setup({ mediaType: "video" })).compose({ layout: "vertical" })).status).toBe(409);
  });

  it("waits for a running redo before composing", async () => {
    const { assets, compose } = await setup({ redo: { status: "running", indexes: [0], taskId: "r1" } });
    expect((await compose({ layout: "vertical" })).status).toBe(409);
    expect(assets.put).not.toHaveBeenCalled();
  });

  it("answers 404 for a message the user does not own", async () => {
    const { service, compose } = await setup();
    service.db.getGenerationMessage = vi.fn(async () => null);
    expect((await compose({ layout: "vertical" })).status).toBe(404);
  });
});

describe("POST /conversations/:id/compose", () => {
  async function png(background: string, width = 32): Promise<Buffer> {
    const { default: sharp } = await import("sharp");
    return sharp({ create: { width, height: 32, channels: 3, background } }).png().toBuffer();
  }
  async function setup() {
    const service = fakeService();
    const files = new Map<string, Buffer>([
      ["a.png", await png("#ff0000")], ["b.png", await png("#00ff00", 64)], ["c.png", await png("#0000ff")], ["other.png", await png("#000000")],
    ]);
    service.db.getGeneratedByStorageKey = vi.fn(async (key: string) => ({
      id: key, user_id: key === "other.png" ? "u2" : "u1", storage_key: key, mime: key === "clip.mp4" ? "video/mp4" : "image/png",
    }));
    service.db.createAsset = vi.fn(async () => {});
    const assets = {
      exists: vi.fn(async (key: string) => files.has(key) || key === "clip.mp4"),
      get: vi.fn(async (key: string) => files.get(key)!),
      put: vi.fn(async ({ key }: { key: string }) => ({ url: `/static/assets/${key}` })),
    };
    const a = new Hono<{ Variables: { userId: string } }>();
    a.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
    a.route("/conversations", createGenerationRoutes(service, { assets: assets as any }));
    const compose = (body: unknown) => a.request("/conversations/c1/compose", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { service, assets, compose };
  }
  const urls = ["/static/assets/b.png", "/static/assets/a.png", "/static/assets/c.png"];

  it("joins picked images in order and posts the picture as a finished image message, without a model request", async () => {
    const { service, assets, compose } = await setup();
    const res = await compose({ urls, layout: "hero", gap: true, prompt: "合成 3 张图片 · 一大多小" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(assets.get.mock.calls.map(([key]) => key)).toEqual(["b.png", "a.png", "c.png"]);
    const [asset] = body.assistantMessage.metadata.assets;
    expect(asset).toMatchObject({ mime: "image/jpeg" });
    expect(asset.url).toMatch(/^\/static\/assets\/[0-9a-f-]+\.jpg$/);
    expect(service.db.createAsset).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", type: "image", taskId: null }));
    expect(service.db.addMessage).toHaveBeenNthCalledWith(1, body.userMessage.id, "c1", "user", "合成 3 张图片 · 一大多小");
      expect(service.db.addMessage).toHaveBeenNthCalledWith(2, body.assistantMessage.id, "c1", "assistant", "", {
        metadata: expect.objectContaining({
          kind: "generation", mediaType: "image", status: "completed",
          composedFrom: expect.objectContaining({ layout: "hero", gap: true, count: 3 }),
        }),
      });
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
    expect(service.usageMeter.checkQuota).not.toHaveBeenCalled();
  });

  it("refuses images that are not this user's generated pictures", async () => {
    for (const bad of ["/static/assets/other.png", "https://vendor.example/x.png", "/static/assets/clip.mp4", "/static/assets/gone.png"]) {
      const { assets, compose } = await setup();
      expect((await compose({ urls: ["/static/assets/a.png", bad], layout: "vertical" })).status).toBe(409);
      expect(assets.put).not.toHaveBeenCalled();
    }
  });

  it("rejects bad picks and conversations the user does not own", async () => {
    const ready = await setup();
    expect((await ready.compose({ urls: ["/static/assets/a.png"], layout: "vertical" })).status).toBe(400);
    expect((await ready.compose({ urls: ["/static/assets/a.png", "/static/assets/a.png"], layout: "vertical" })).status).toBe(400);
    expect((await ready.compose({ urls: urls.slice(0, 2), layout: "hero" })).status).toBe(400);
    expect((await ready.compose({ urls: Array.from({ length: 10 }, (_, i) => `/static/assets/${i}.png`), layout: "grid" })).status).toBe(400);
    expect((await ready.compose({ urls, layout: "spiral" })).status).toBe(400);
    ready.service.db.getConversation = vi.fn(async () => ({ id: "c1", user_id: "u2" }));
    expect((await ready.compose({ urls, layout: "vertical" })).status).toBe(404);
    expect(ready.service.db.addMessage).not.toHaveBeenCalled();
  });
});

describe("POST /conversations/:id/generations/:messageId/redo", () => {
  const a = { url: "/static/assets/a.png", mime: "image/png" };
  const b = { url: "/static/assets/b.png", mime: "image/png" };
  function setup(metadata: Record<string, unknown> = {}, taskInput: Record<string, unknown> = {}) {
    const service = fakeService();
    let meta: Record<string, unknown> = {
      kind: "generation", mediaType: "image", status: "completed", scene: "main_images", taskId: "orig", assets: [a, b], ...metadata,
    };
    service.db.getGenerationMessage = vi.fn(async () => ({ status: "completed", metadata: meta }));
    service.db.getTask = vi.fn(async () => ({
      id: "orig", type: "image.generate", user_id: "u1",
      input: { prompt: "main", prompts: ["main", "angle", "detail", "scene"], size: "1024x1024", quality: "high", ratio: "1:1", resolution: "1K",
        modelId: "gpt-image-2", requireUserModelKey: false, conversationId: "c1", assistantMessageId: "m1", ...taskInput },
    }));
    type Update = (m: Record<string, unknown>) => Record<string, unknown> | null;
    service.db.updateGenerationMetadata = vi.fn(async (_id: string, _owner: unknown, update: Update) => {
      const next = update(meta);
      if (next) meta = next;
      return !!next;
    });
    service.jobQueue.enqueue = vi.fn(async () => "redo-1");
    const redo = (body: unknown) => app(service).request("/conversations/c1/generations/m1/redo", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { service, redo, meta: () => meta };
  }

  it("redoes one image with its own prompt and the original settings, keeping it alike through another image of the set", async () => {
    const { service, redo, meta } = setup();
    const res = await redo({ index: 0 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ taskId: "redo-1", redo: { status: "running", indexes: [0], taskId: "redo-1" } });
    const [type, input, userId] = service.jobQueue.enqueue.mock.calls[0];
    expect(type).toBe("image.set_redo");
    expect(userId).toBe("u1");
    expect(input).toMatchObject({
      prompts: ["main"], indexes: [0], n: 1, size: "1024x1024", quality: "high", modelId: "gpt-image-2",
      setReference: b.url, redoMessageId: "m1", conversationId: "c1",
    });
    // A redo must never be mistaken for the original generation message.
    expect(input).not.toHaveProperty("assistantMessageId");
    expect(meta().redo).toEqual({ status: "running", indexes: [0], taskId: "redo-1" });
    expect(service.usageMeter.checkQuota).toHaveBeenCalled();
  });

  it("fills the missing images in order and uses the user's own reference when there was one", async () => {
    const media = [{ type: "reference_image", url: "/static/uploads/cup.png" }];
    const { service, redo } = setup({ missing: 2 }, { media });
    const res = await redo({ missing: true });
    expect(res.status).toBe(202);
    const input = service.jobQueue.enqueue.mock.calls[0][1];
    expect(input).toMatchObject({ indexes: [2, 3], prompts: ["detail", "scene"], media });
    expect(input.setReference).toBeUndefined();
  });

  it("refuses a second redo while one is running, and a set with nothing missing", async () => {
    const running = setup({ redo: { status: "running", indexes: [1], taskId: "x" } });
    expect((await running.redo({ index: 0 })).status).toBe(409);
    const full = setup({}, { prompts: ["main", "angle"] });
    expect((await full.redo({ missing: true })).status).toBe(409);
    expect(running.service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("only redoes finished 产品套图 / 主副图 the user owns, at a real position", async () => {
    expect((await setup({ scene: undefined }).redo({ index: 0 })).status).toBe(409);
    expect((await setup({ scene: "white_background" }).redo({ index: 0 })).status).toBe(409);
    expect((await setup({ status: "generating" }).redo({ index: 0 })).status).toBe(409);
    expect((await setup().redo({ index: 5 })).status).toBe(400);
    expect((await setup().redo({})).status).toBe(400);
    const foreign = setup();
    foreign.service.db.getTask = vi.fn(async () => ({ id: "orig", user_id: "u2", input: { prompts: ["x", "y"] } }));
    expect((await foreign.redo({ index: 0 })).status).toBe(409);
  });

  it("checks the quota before anything is queued", async () => {
    const { service, redo, meta } = setup();
    service.usageMeter.checkQuota.mockResolvedValue({ ok: false, reason: "daily limit", code: "DAILY_LIMIT_EXCEEDED" });
    expect((await redo({ index: 1 })).status).toBe(402);
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
    expect(meta().redo).toBeUndefined();
  });

  it("releases the set when queueing fails", async () => {
    const { service, redo, meta } = setup();
    service.jobQueue.enqueue = vi.fn(async () => { throw new Error("redis down"); });
    expect((await redo({ index: 1 })).status).toBe(500);
    expect(meta().redo).toBeUndefined();
  });
});

describe("POST /conversations/:id/generations/:messageId/export", () => {
  async function setup(metadata: Record<string, unknown> = {}) {
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#3388cc" } }).png().toBuffer();
    const service = fakeService();
    service.db.getGenerationMessage = vi.fn(async () => ({
      status: "completed",
      metadata: {
        kind: "generation", mediaType: "image", status: "completed",
        assets: [{ url: "/static/assets/a.png", mime: "image/png" }, { url: "/static/assets/b.png", mime: "image/png" }],
        composites: [{ url: "/static/assets/long.jpg", mime: "image/jpeg", layout: "vertical", gap: false }],
        ...metadata,
      },
    }));
    service.db.getGeneratedByStorageKey = vi.fn(async (key: string) => ({ user_id: key === "other.png" ? "u2" : "u1", storage_key: key }));
    const assets = { exists: vi.fn(async () => true), get: vi.fn(async () => png), put: vi.fn() };
    const a = new Hono<{ Variables: { userId: string } }>();
    a.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
    a.route("/conversations", createGenerationRoutes(service, { assets: assets as any }));
    const exportZip = (body: unknown) => a.request("/conversations/c1/generations/m1/export", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { service, assets, exportZip };
  }

  it("returns a zip of the images and composites under the card's names, without metering", async () => {
    const { default: JSZip } = await import("jszip");
    const { service, exportZip } = await setup();
    const res = await exportZip({ preset: "taobao", names: ["主图_01", "其他/角度_02"], compositeNames: ["长图"] });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(["主图_01.jpg", "其他角度_02.jpg", "长图.jpg"]);
    expect(service.usageMeter.checkQuota).not.toHaveBeenCalled();
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("refuses files that are not this user's stored output, unknown presets and unfinished generations", async () => {
    const foreign = await setup({ assets: [{ url: "/static/assets/other.png", mime: "image/png" }] });
    expect((await foreign.exportZip({ preset: "original" })).status).toBe(409);
    const external = await setup({ assets: [{ url: "https://vendor.example/a.png", mime: "image/png" }] });
    expect((await external.exportZip({ preset: "original" })).status).toBe(409);
    expect((await (await setup()).exportZip({ preset: "amazon" })).status).toBe(400);
    expect((await (await setup({ status: "generating" })).exportZip({ preset: "original" })).status).toBe(409);
  });
});

describe("真实字体 posters", () => {
  const send = (service: any, body: Record<string, unknown>) => app(service).request("/conversations/c1/generations", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaType: "image", ...body }),
  });
  const plan = JSON.stringify({
    background: "A steaming hot pot on a wooden table", template: "side_panel", title: "火锅店盛大开业", subtitle: "", points: [],
    price: "¥199", originalPrice: "¥299", discount: "8 折", date: "", address: "",
  });

  it("plans the wording, sends a text-free picture prompt and keeps the user's text on the card", async () => {
    const service = fakeService();
    service.imageSceneText = vi.fn(async () => plan);
    const res = await send(service, { prompt: "火锅店开业海报，全场 8 折，套餐 199 元", realText: true, settings: { size: "1024x1536", n: 1 } });
    expect(res.status).toBe(202);
    const [, input] = service.jobQueue.enqueue.mock.calls[0];
    expect(input.prompt).toContain("A steaming hot pot");
    expect(input.prompt).toContain("no text");
    expect(input.displayPrompt).toBe("火锅店开业海报，全场 8 折，套餐 199 元");
    // A side panel writes in columns, so it stays on a portrait canvas; the invented original price is emptied.
    expect(input.prompt).toContain("right 55% of the frame");
    expect(input.poster).toMatchObject({
      template: "side_panel", cleared: ["price", "originalPrice"], fields: { title: "火锅店盛大开业", price: "", originalPrice: "", discount: "8 折" },
    });
    expect(service.messages.at(-1).metadata).toMatchObject({ poster: input.poster, prompt: "火锅店开业海报，全场 8 折，套餐 199 元" });
  });

  it("sends nothing when the wording cannot be planned, and plans nothing with the switch off", async () => {
    const broken = fakeService();
    broken.imageSceneText = vi.fn(async () => "not json");
    const res = await send(broken, { prompt: "火锅店开业海报", realText: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "IMAGE_SCENE_UNAVAILABLE" });
    expect(broken.jobQueue.enqueue).not.toHaveBeenCalled();
    expect(broken.messages).toHaveLength(0);

    const off = fakeService();
    off.imageSceneText = vi.fn();
    expect((await send(off, { prompt: "火锅店开业海报" })).status).toBe(202);
    expect(off.imageSceneText).not.toHaveBeenCalled();
    expect(off.jobQueue.enqueue.mock.calls[0][1].poster).toBeUndefined();
  });

  async function setup(metadata: Record<string, unknown> = {}) {
    const { default: sharp } = await import("sharp");
    const service = fakeService();
    const files = new Map<string, Buffer>([
      ["bg.png", await sharp({ create: { width: 256, height: 384, channels: 3, background: "#e9dcc3" } }).png().toBuffer()],
    ]);
    const fields = { title: "火锅店盛大开业", subtitle: "", points: [], price: "", originalPrice: "", discount: "", date: "", address: "" };
    const meta: Record<string, unknown> = {
      kind: "generation", mediaType: "image", status: "completed", taskId: "task-1",
      assets: [{ url: "/static/assets/old.png", mime: "image/png" }],
      posters: [{ version: 1, template: "bottom_panel", fields, cleared: ["price"], background: { url: "/static/assets/bg.png" } }],
      composites: [{ url: "/static/assets/joined.jpg", mime: "image/jpeg", layout: "vertical", gap: false }],
      ...metadata,
    };
    let saved: Record<string, unknown> | null = null;
    service.db.getGenerationMessage = vi.fn(async () => ({ status: "completed", metadata: meta }));
    service.db.getGeneratedByStorageKey = vi.fn(async (key: string) => (
      key.startsWith("poster-") ? null : { user_id: key === "other.png" ? "u2" : "u1", storage_key: key, url: `/static/assets/${key}` }
    ));
    service.db.createAsset = vi.fn(async () => {});
    service.db.updateGenerationMetadata = vi.fn(async (_id: string, _owner: unknown, update: (current: any) => any) => {
      saved = update(meta);
      return !!saved;
    });
    const assets = {
      exists: vi.fn(async (key: string) => files.has(key)),
      get: vi.fn(async (key: string) => files.get(key)!),
      put: vi.fn(async ({ key, body }: { key: string; body: Buffer }) => { files.set(key, body); return { url: `/static/assets/${key}` }; }),
    };
    const a = new Hono<{ Variables: { userId: string } }>();
    a.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
    a.route("/conversations", createGenerationRoutes(service, { assets: assets as any }));
    const edit = (body: unknown) => a.request("/conversations/c1/generations/m1/poster", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { service, assets, edit, fields, saved: () => saved };
  }

  it("renders new wording on the stored picture without a model request", async () => {
    const { service, assets, edit, fields, saved } = await setup();
    const res = await edit({ index: 0, fields: { ...fields, price: "¥188" }, template: "overlay" });
    expect(res.status).toBe(200);
    const body = await res.json() as { asset: { url: string }; poster: { cleared?: string[] } };
    expect(body.asset.url).toMatch(/^\/static\/assets\/poster-[0-9a-f]{32}\.png$/);
    expect(body.poster).toMatchObject({ template: "overlay", fields: { price: "¥188" }, background: { url: "/static/assets/bg.png" } });
    expect(body.poster.cleared).toBeUndefined();
    expect(assets.put).toHaveBeenCalledTimes(1);
    expect(service.db.createAsset).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", type: "image" }));
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
    expect(service.usageMeter.checkQuota).not.toHaveBeenCalled();
    // The picture joined from the old image is dropped with it.
    expect(saved()).toMatchObject({ assets: [body.asset], posters: [body.poster] });
    expect(saved()).not.toHaveProperty("composites");
  });

  it("refuses images without a poster, other users' pictures and unfinished messages", async () => {
    const fields = { title: "开业" };
    expect((await (await setup()).edit({ index: 1, fields })).status).toBe(409);
    expect((await (await setup({ posters: undefined })).edit({ index: 0, fields })).status).toBe(409);
    expect((await (await setup({ status: "generating" })).edit({ index: 0, fields })).status).toBe(409);
    const foreign = await setup({ posters: [{ template: "overlay", fields, background: { url: "/static/assets/other.png" } }] });
    expect((await foreign.edit({ index: 0, fields })).status).toBe(409);
    const external = await setup({ posters: [{ template: "overlay", fields, background: { url: "https://example.com/bg.png" } }] });
    expect((await external.edit({ index: 0, fields })).status).toBe(409);
    expect(foreign.assets.put).not.toHaveBeenCalled();
    expect((await (await setup()).edit({ index: 0 })).status).toBe(400);
    const gone = await setup();
    gone.service.db.getGenerationMessage = vi.fn(async () => null);
    expect((await gone.edit({ index: 0, fields })).status).toBe(404);
  });
});
