import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createKeyRoutes } from "./keys.js";

function svc(setActive: ReturnType<typeof vi.fn>) {
  return {
    db: { setActiveApiKey: setActive },
    redis: { del: vi.fn().mockResolvedValue(1) },
  } as unknown as import("../services/agent-service.js").AgentService;
}
function mount(service: import("../services/agent-service.js").AgentService) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/", createKeyRoutes(service));
  return app;
}
const post = (app: ReturnType<typeof mount>, body: unknown) =>
  app.request("/active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/keys/active", () => {
  it("switches active key and clears the model cache", async () => {
    const setActive = vi.fn().mockResolvedValue("sk-B");
    const service = svc(setActive);
    const res = await post(mount(service), { index: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, activeKeyIndex: 1 });
    expect(setActive).toHaveBeenCalledWith("u1", 1);
    expect(service.redis.del).toHaveBeenCalledWith("models:u1");
  });

  it("returns 400 when the index is out of range", async () => {
    const setActive = vi.fn().mockRejectedValue(new Error("index_out_of_range"));
    const res = await post(mount(svc(setActive)), { index: 9 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("无效的 key");
  });

  it("returns 500 when setActiveApiKey fails for a non-range reason", async () => {
    const setActive = vi.fn().mockRejectedValue(new Error("db_down"));
    const service = svc(setActive);
    const res = await post(mount(service), { index: 1 });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "切换失败" });
    expect(service.redis.del).not.toHaveBeenCalled();
  });

  it("returns 400 when index is missing/not a number", async () => {
    const setActive = vi.fn();
    const res = await post(mount(svc(setActive)), {});
    expect(res.status).toBe(400);
    expect(setActive).not.toHaveBeenCalled();
  });
});
