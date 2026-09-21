import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createImageShareRoutes, createPublicImageShareRoutes } from "./image-shares.js";
import { createAuthMiddleware } from "../auth/middleware.js";

const token = "a".repeat(48);
function setup() {
  let active: string | null = null;
  const db = {
    getOwnedImageShare: vi.fn(async (key, userId) => key === "own.png" && userId === "u1" ? { token: active } : null),
    createImageShare: vi.fn(async (key, userId, nextToken, title) => {
      if (key !== "own.png" || userId !== "u1") return null;
      active ??= nextToken;
      return { token: active, title, url: "/static/assets/own.png" };
    }),
    getSharedImage: vi.fn(async (id) => id === active ? {
      title: "分享的作品", url: "/static/assets/own.png", mime: "image/png",
      user_id: "u1", task_id: "private-task", prompt: "private-prompt",
    } : null),
    revokeImageShare: vi.fn(async (id, userId) => {
      if (id !== active || userId !== "u1") return false;
      active = null;
      return true;
    }),
  };
  const app = new Hono<{ Variables: { userId: string } }>();
  app.route("/public", createPublicImageShareRoutes({ db } as any));
  app.use("/private/*", async (c, next) => { c.set("userId", c.req.header("x-user") ?? "u1"); await next(); });
  app.route("/private", createImageShareRoutes({ db } as any));
  const create = (url = "https://media.example.com/static/assets/own.png", user = "u1") => app.request("/private", {
    method: "POST", headers: { "Content-Type": "application/json", "x-user": user }, body: JSON.stringify({ url, title: "作品" }),
  });
  return { app, db, create };
}

describe("scoped image sharing", () => {
  it("requires a session for share management while anonymous reads remain available", async () => {
    const { db } = setup();
    const app = new Hono();
    app.route("/api/public/shares", createPublicImageShareRoutes({ db } as any));
    app.use("/api/assets/*", createAuthMiddleware({ resolve: vi.fn().mockResolvedValue(null) } as any));
    app.route("/api/assets/shares", createImageShareRoutes({ db } as any));
    for (const [url, method] of [["/api/assets/shares", "POST"], ["/api/assets/shares?url=test", "GET"], [`/api/assets/shares/${token}`, "DELETE"]]) {
      expect((await app.request(url, { method })).status).toBe(401);
    }
    expect(db.createImageShare).not.toHaveBeenCalled();
    expect((await app.request(`/api/public/shares/${token}`)).status).toBe(404);
    expect(db.getSharedImage).toHaveBeenCalledWith(token);
  });
  it("shares only the chosen owned image, anonymously, and revokes old links permanently", async () => {
    const { app, create } = setup();
    const created = await create();
    expect(created.status).toBe(200);
    const share = await created.json() as { token: string };
    expect(share.token).toMatch(/^[a-f0-9]{48}$/);
    const publicRes = await app.request(`/public/${share.token}`);
    expect(await publicRes.json()).toEqual({ title: "分享的作品", url: "/static/assets/own.png", mime: "image/png" });
    expect(publicRes.headers.get("cache-control")).toBe("no-store");
    expect((await (await create()).json() as { token: string }).token).toBe(share.token);
    expect((await app.request(`/private/${share.token}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/public/${share.token}`)).status).toBe(404);
    expect((await (await create()).json() as { token: string }).token).not.toBe(share.token);
    expect((await app.request(`/public/${share.token}`)).status).toBe(404);
  });

  it("does not let another account publish, inspect or revoke an image share", async () => {
    const { app, create } = setup();
    const share = await (await create()).json() as { token: string };
    expect((await create(undefined, "u2")).status).toBe(404);
    expect((await app.request(`/private?url=${encodeURIComponent('/static/assets/own.png')}`, { headers: { "x-user": "u2" } })).status).toBe(404);
    expect((await app.request(`/private/${share.token}`, { method: "DELETE", headers: { "x-user": "u2" } })).status).toBe(404);
    expect((await app.request(`/public/${share.token}`)).status).toBe(200);
  });

  it.each(["/static/uploads/secret.png", "file:///static/assets/own.png", "https://example.com/anything", "/static/assets/../secret", "/static/assets/%2Fsecret"])("rejects unsupported media paths %s", async (url) => {
    const { create, db } = setup();
    expect((await create(url)).status).toBe(400);
    expect(db.createImageShare).not.toHaveBeenCalled();
  });

  it("does not query the database for malformed public tokens", async () => {
    const { app, db } = setup();
    expect((await app.request("/public/bad-token")).status).toBe(404);
    expect(db.getSharedImage).not.toHaveBeenCalled();
    expect((await app.request(`/public/${token}`)).status).toBe(404);
  });
});
