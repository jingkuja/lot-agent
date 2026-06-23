import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createAuthMiddleware } from "./middleware.js";
import type { SessionStore } from "./session-store.js";

// ── Fake SessionStore ──

function makeFakeSessionStore(validToken: string, userId: string): SessionStore {
  return {
    createSession: async () => validToken,
    resolve: async (token: string) => {
      if (token === validToken) return { userId };
      return null;
    },
    revoke: async () => {},
  } as unknown as SessionStore;
}

function buildApp(sessions: SessionStore) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", createAuthMiddleware(sessions));
  app.get("/test", (c) => {
    return c.json({ userId: c.get("userId") });
  });
  return app;
}

describe("createAuthMiddleware", () => {
  const sessions = makeFakeSessionStore("good-token", "user-123");
  const app = buildApp(sessions);

  it("returns 401 when no Authorization header", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for Bearer with invalid token", async () => {
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer bad-token" },
    });
    expect(res.status).toBe(401);
  });

  it("passes through and sets userId for valid token", async () => {
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer good-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { userId: string };
    expect(body.userId).toBe("user-123");
  });

  it("returns 401 when Authorization header is not Bearer scheme", async () => {
    const res = await app.request("/test", {
      headers: { Authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });
});
