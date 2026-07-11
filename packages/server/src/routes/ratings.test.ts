import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createRatingRoutes } from "./ratings.js";

function fakeService(opts: { messageOwner?: string | null } = {}) {
  const owner = opts.messageOwner === undefined ? "u1" : opts.messageOwner;
  return {
    db: {
      getMessageOwner: vi.fn(async () =>
        owner == null ? null : { conversationId: "c1", userId: owner }
      ),
      setRating: vi.fn(async (messageId: string, rating: number, feedback?: string) => ({
        message_id: messageId,
        rating,
        feedback: feedback ?? null,
      })),
      getRating: vi.fn(async () => ({ message_id: "m1", rating: 1 })),
      removeRating: vi.fn(async () => true),
    },
  } as any;
}

function app(service: any) {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", "u1");
    await next();
  });
  a.route("/ratings", createRatingRoutes(service));
  return a;
}

const post = (a: Hono, body: unknown) =>
  a.request("/ratings/m1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("ratings ownership", () => {
  it("rates the caller's own message", async () => {
    const service = fakeService();
    const res = await post(app(service), { rating: 1 });
    expect(res.status).toBe(200);
    expect(service.db.setRating).toHaveBeenCalledWith("m1", 1, undefined);
  });

  it("404s when rating another user's message", async () => {
    const service = fakeService({ messageOwner: "other" });
    const res = await post(app(service), { rating: 1 });
    expect(res.status).toBe(404);
    expect(service.db.setRating).not.toHaveBeenCalled();
  });

  it("404s when reading a rating on another user's message", async () => {
    const service = fakeService({ messageOwner: "other" });
    const res = await app(service).request("/ratings/m1");
    expect(res.status).toBe(404);
    expect(service.db.getRating).not.toHaveBeenCalled();
  });

  it("404s when deleting a rating on another user's message", async () => {
    const service = fakeService({ messageOwner: "other" });
    const res = await app(service).request("/ratings/m1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(service.db.removeRating).not.toHaveBeenCalled();
  });

  it("404s for an unknown message", async () => {
    const service = fakeService({ messageOwner: null });
    const res = await post(app(service), { rating: -1 });
    expect(res.status).toBe(404);
  });

  it("still rejects invalid rating values with 400", async () => {
    const service = fakeService();
    const res = await post(app(service), { rating: 5 });
    expect(res.status).toBe(400);
  });
});
