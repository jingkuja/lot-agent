import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createTaskRoutes } from "./tasks.js";

function fakeService(job: Record<string, unknown> | null) {
  return {
    modelRegistry: { getConfig: vi.fn(() => ({ unitPrice: 0.04 })) },
    usageMeter: { checkQuota: vi.fn(async () => ({ ok: true })) },
    jobQueue: {
      enqueue: vi.fn(async () => "task-1"),
      get: vi.fn(async () => job),
      cancel: vi.fn(async () => true),
    },
    db: { markMessageGenerationCancelled: vi.fn(async () => {}) },
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

const cancel = (a: Hono) => a.request("/tasks/task-1/cancel", { method: "POST" });

describe("POST /tasks/:id/cancel", () => {
  it("cancels the caller's own task", async () => {
    const service = fakeService({ id: "task-1", userId: "u1", status: "running", input: {} });
    const res = await cancel(app(service));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "cancelled" });
    expect(service.jobQueue.cancel).toHaveBeenCalledWith("task-1");
  });

  it("marks the linked generation message cancelled", async () => {
    const service = fakeService({
      id: "task-1",
      userId: "u1",
      status: "running",
      input: { assistantMessageId: "m1", conversationId: "c1" },
    });
    await cancel(app(service));
    expect(service.db.markMessageGenerationCancelled).toHaveBeenCalledWith("m1", {
      conversationId: "c1",
      userId: "u1",
    });
  });

  it("404s for another user's task", async () => {
    const service = fakeService({ id: "task-1", userId: "other", status: "running", input: {} });
    const res = await cancel(app(service));
    expect(res.status).toBe(404);
    expect(service.jobQueue.cancel).not.toHaveBeenCalled();
  });

  it("404s for an unknown task", async () => {
    const service = fakeService(null);
    const res = await cancel(app(service));
    expect(res.status).toBe(404);
  });

  it("reports the current status when the task is already terminal", async () => {
    const service = fakeService({ id: "task-1", userId: "u1", status: "succeeded", input: {} });
    service.jobQueue.cancel = vi.fn(async () => false);
    const res = await cancel(app(service));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, status: "succeeded" });
    expect(service.db.markMessageGenerationCancelled).not.toHaveBeenCalled();
  });
});
