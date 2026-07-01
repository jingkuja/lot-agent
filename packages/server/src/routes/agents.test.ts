import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createAgentRoutes } from "./agents.js";

function fakeService(installed: Map<string, number>) {
  return {
    agentRegistry: {
      list: () => [
        { id: "general", name: "通用助手", type: "general", description: "", toolNames: [], defaultModelId: "m" },
        { id: "image", name: "图片生成", type: "image", description: "", toolNames: [], defaultModelId: "m" },
        { id: "contract", name: "合同审核", type: "contract", description: "", toolNames: [], defaultModelId: "m" },
      ],
      get: (id: string) => (["general", "image", "contract"].includes(id) ? { id } : undefined),
    },
    db: {
      getUserAgents: vi.fn(async () => installed),
      installUserAgent: vi.fn(async () => {}),
      uninstallUserAgent: vi.fn(async () => {}),
      promoteUserAgent: vi.fn(async () => {}),
      isUserAgentInstalled: vi.fn(async (_u: string, id: string) => installed.has(id)),
    },
  } as any;
}

function app(service: any) {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  a.route("/agents", createAgentRoutes(service));
  return a;
}

describe("agents routes", () => {
  it("GET annotates installed + sortOrder", async () => {
    const res = await app(fakeService(new Map([["general", 0], ["image", 1]]))).request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.map((a: any) => [a.id, a]));
    expect(byId.general.installed).toBe(true);
    expect(byId.image).toMatchObject({ installed: true, sortOrder: 1 });
    expect(byId.contract).toMatchObject({ installed: false, sortOrder: null });
  });

  it("POST install unknown id -> 404", async () => {
    const res = await app(fakeService(new Map())).request("/agents/nope/install", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST install known id -> ok + calls db", async () => {
    const svc = fakeService(new Map());
    const res = await app(svc).request("/agents/contract/install", { method: "POST" });
    expect(res.status).toBe(200);
    expect(svc.db.installUserAgent).toHaveBeenCalledWith("u1", "contract");
  });

  it("DELETE general -> 400", async () => {
    const res = await app(fakeService(new Map())).request("/agents/general/install", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("DELETE installed sub-agent -> ok", async () => {
    const svc = fakeService(new Map([["image", 1]]));
    const res = await app(svc).request("/agents/image/install", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(svc.db.uninstallUserAgent).toHaveBeenCalledWith("u1", "image");
  });

  it("POST promote unknown id -> 404", async () => {
    const res = await app(fakeService(new Map())).request("/agents/nope/promote", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST promote not-installed -> 400", async () => {
    const res = await app(fakeService(new Map())).request("/agents/contract/promote", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("POST promote installed -> ok", async () => {
    const svc = fakeService(new Map([["contract", 2]]));
    const res = await app(svc).request("/agents/contract/promote", { method: "POST" });
    expect(res.status).toBe(200);
    expect(svc.db.promoteUserAgent).toHaveBeenCalledWith("u1", "contract");
  });
});
