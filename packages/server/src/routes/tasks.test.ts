import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createTaskRoutes } from "./tasks.js";

function fakeService() {
  return {
    modelRegistry: { getConfig: vi.fn(() => ({ unitPrice: 0.04 })) },
    usageMeter: { checkQuota: vi.fn(async () => ({ ok: true })) },
    jobQueue: {
      enqueue: vi.fn(async () => "task-1"),
      get: vi.fn(async () => ({ id: "task-1", userId: "u1", status: "running" })),
    },
  } as any;
}

function app(service: any) {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", "u1");
    await next();
  });
  a.route("/tasks", createTaskRoutes(service));
  return a;
}

describe("POST /tasks input whitelisting", () => {
  it("enqueues only whitelisted business fields", async () => {
    const service = fakeService();
    const res = await app(service).request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image.generate",
        input: { prompt: "菊花", size: "1024x1024", n: 1, modelId: "gpt-image-2-token" },
      }),
    });
    expect(res.status).toBe(202);
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "image.generate",
      { prompt: "菊花", size: "1024x1024", n: 1, quality: "auto", modelId: "gpt-image-2-token" },
      "u1"
    );
  });

  it("strips message/conversation identity fields from the input", async () => {
    const service = fakeService();
    const res = await app(service).request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image.generate",
        input: {
          prompt: "菊花",
          assistantMessageId: "victim-message",
          conversationId: "victim-conversation",
          userId: "victim-user",
        },
      }),
    });
    expect(res.status).toBe(202);
    const input = service.jobQueue.enqueue.mock.calls[0][1];
    expect(input).toEqual({ prompt: "菊花", quality: "auto" });
  });

  it("rejects a custom image size that is not a multiple of 16", async () => {
    const service = fakeService();
    const res = await app(service).request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image.generate",
        input: { prompt: "菊花", size: "1000x1000" },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "宽和高都必须能被 16 整除" });
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects image edits with more than five reference images", async () => {
    const service = fakeService();
    const res = await app(service).request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image.generate",
        input: {
          prompt: "改图",
          media: Array.from({ length: 6 }, (_, i) => ({
            type: "reference_image",
            url: `/static/uploads/${i}.png`,
          })),
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(service.jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("whitelists video references and frames", async () => {
    const service = fakeService();
    const res = await app(service).request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "video.generate",
        input: {
          prompt: "镜头推进",
          input_reference: ["a", "b"],
          reference_video: ["v1", "v2"],
          reference_audio: "a1",
          generate_audio: false,
          first_frame: "first",
          last_frame: "last",
        },
      }),
    });
    expect(res.status).toBe(202);
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({
        input_reference: ["a", "b"],
        reference_video: ["v1", "v2"],
        reference_audio: "a1",
        generate_audio: true,
        first_frame: "first",
        last_frame: "last",
      }),
      "u1"
    );
  });
});
