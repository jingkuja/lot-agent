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
    expect(service.generateTitle).toHaveBeenCalledWith("c1", "菊花", []);
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
});
