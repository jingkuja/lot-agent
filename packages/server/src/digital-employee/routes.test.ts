import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDigitalEmployeeRoutes } from "./routes.js";
import { NotFoundError } from "./errors.js";

function app(service: Record<string, unknown>) {
  const server = new Hono<{ Variables: { userId: string } }>();
  server.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  server.route("/digital-employee", createDigitalEmployeeRoutes(service as any));
  return server;
}

describe("digital employee profile routes", () => {
  it("passes the authenticated owner to list queries", async () => {
    const service = { listProfiles: vi.fn(async () => ({ items: [], page: 1, limit: 20, total: 0 })) };
    const response = await app(service).request("/digital-employee/profiles?q=%E6%9D%8E%E5%A7%90");
    expect(response.status).toBe(200);
    expect(service.listProfiles).toHaveBeenCalledWith("u1", expect.objectContaining({ query: "李姐" }));
  });

  it("does not turn an owner-scoped not-found into a different response", async () => {
    const service = { getProfile: vi.fn(async () => { throw new NotFoundError(); }) };
    const response = await app(service).request("/digital-employee/profiles/00000000-0000-0000-0000-000000000001");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("requires optimistic-lock version for archive", async () => {
    const service = { archiveProfile: vi.fn() };
    const response = await app(service).request("/digital-employee/profiles/00000000-0000-0000-0000-000000000001", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(service.archiveProfile).not.toHaveBeenCalled();
  });

  it("rejects malformed UUIDs before reaching the service", async () => {
    const service = { getProfile: vi.fn() };
    const response = await app(service).request("/digital-employee/profiles/not-a-uuid");
    expect(response.status).toBe(400);
    expect(service.getProfile).not.toHaveBeenCalled();
  });

  it("clears current-customer context within the authenticated conversation", async () => {
    const service = { clearCurrentProfile: vi.fn(async () => {}) };
    const conversationId = "00000000-0000-0000-0000-000000000009";
    const response = await app(service).request(`/digital-employee/conversation-context/${conversationId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(service.clearCurrentProfile).toHaveBeenCalledWith("u1", conversationId);
  });
});
