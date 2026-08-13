import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createTraceRoutes } from "./traces.js";

function fakeService(opts: { conversationOwner?: string | null } = {}) {
  const owner = opts.conversationOwner === undefined ? "u1" : opts.conversationOwner;
  return {
    db: {
      getConversation: vi.fn(async () =>
        owner == null ? null : { id: "c1", user_id: owner }
      ),
      getTraces: vi.fn(async () => [{ id: "t1", conversation_id: "c1" }]),
      getTrace: vi.fn(async () => ({ id: "t1", conversation_id: "c1" })),
      getSpans: vi.fn(async () => [{ id: "s1" }]),
    },
  } as any;
}

function app(service: any) {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", "u1");
    await next();
  });
  a.route("/traces", createTraceRoutes(service));
  return a;
}

describe("GET /traces", () => {
  it("returns the caller's own conversation traces", async () => {
    const service = fakeService();
    const res = await app(service).request("/traces?conversationId=c1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "t1", conversation_id: "c1" }]);
    expect(service.db.getTraces).toHaveBeenCalledWith("c1");
  });

  it("requires conversationId — no site-wide trace listing", async () => {
    const service = fakeService();
    const res = await app(service).request("/traces");
    expect(res.status).toBe(400);
    expect(service.db.getTraces).not.toHaveBeenCalled();
  });

  it("404s for another user's conversation", async () => {
    const service = fakeService({ conversationOwner: "other" });
    const res = await app(service).request("/traces?conversationId=c1");
    expect(res.status).toBe(404);
    expect(service.db.getTraces).not.toHaveBeenCalled();
  });

  it("404s for a missing conversation", async () => {
    const service = fakeService({ conversationOwner: null });
    const res = await app(service).request("/traces?conversationId=c1");
    expect(res.status).toBe(404);
  });
});

describe("GET /traces/:id", () => {
  it("returns an owned trace with its spans", async () => {
    const service = fakeService();
    const res = await app(service).request("/traces/t1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "t1",
      conversation_id: "c1",
      spans: [{ id: "s1" }],
    });
  });

  it("404s when the trace belongs to another user's conversation", async () => {
    const service = fakeService({ conversationOwner: "other" });
    const res = await app(service).request("/traces/t1");
    expect(res.status).toBe(404);
    expect(service.db.getSpans).not.toHaveBeenCalled();
  });

  it("404s for an unknown trace", async () => {
    const service = fakeService();
    service.db.getTrace = vi.fn(async () => null);
    const res = await app(service).request("/traces/t1");
    expect(res.status).toBe(404);
  });
});
