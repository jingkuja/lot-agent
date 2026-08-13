import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createGenerationRoutes } from "./conversations.js";

function fakeService() {
  const messages: any[] = [];
  return {
    messages,
    db: {
      getConversation: vi.fn(async () => ({ id: "c1", user_id: "u1" })),
      addMessage: vi.fn(async (id: string, _cid: string, role: string, content: string, opts: any) => {
        messages.push({ id, role, content, ...opts });
      }),
      updateMessageGeneration: vi.fn(async () => {}),
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

function app(service: any) {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  a.route("/conversations", createGenerationRoutes(service));
  return a;
}

describe("POST /conversations/:id/generations", () => {
  it("persists user + assistant messages and enqueues a task", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", settings: { size: "1024x1024", n: 1 } }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.taskId).toBe("task-1");
    expect(body.userMessage.content).toBe("菊花");
    expect(body.assistantMessage.status).toBe("generating");
    // The synchronous image provider reports no progress, so the metadata tells
    // the client not to show a percentage.
    expect(body.assistantMessage.metadata.supportsProgress).toBe(false);
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({ prompt: "菊花", conversationId: "c1", assistantMessageId: body.assistantMessage.id, size: "1024x1024" }),
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
    const body = await res.json();
    expect(service.generateTitle).toHaveBeenCalledWith("c1", "菊花", [], { userId: "u1" });
    expect(body.title).toBe("菊花特写");
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
    const body = await res.json();
    const input = service.jobQueue.enqueue.mock.calls[0][1];
    expect(input.assistantMessageId).toBe(body.assistantMessage.id);
    expect(input.conversationId).toBe("c1");
    expect(input.userId).toBeUndefined();
    // The persisted metadata must not echo the forged identity fields either.
    expect(body.assistantMessage.metadata.settings).toEqual({ n: 1 });
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

  it("rejects image edits with more than one reference image", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "菊花",
        mediaType: "image",
        media: [
          { type: "reference_image", url: "/static/uploads/a.png" },
          { type: "reference_image", url: "/static/uploads/b.png" },
        ],
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

  it("rejects video references over their limits", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", mediaType: "video", reference_video: ["1", "2", "3"] }),
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
    const body = await res.json();
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
