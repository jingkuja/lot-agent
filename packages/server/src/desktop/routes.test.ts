import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDesktopToolRoutes } from "./routes.js";
import { createConversationRoutes } from "../routes/conversations.js";
import { DesktopToolBroker } from "./broker.js";

function setup(owner = "user", agent = "general") {
  const service = {
    desktopTools: new DesktopToolBroker(),
    db: {
      getConversation: vi.fn(async () => ({ id: "chat", user_id: owner, agent_id: agent })),
      claimConversationRun: vi.fn(async () => true), releaseConversationRun: vi.fn(async () => {}),
    },
    streamAgentResponse: vi.fn(async function* (..._args: unknown[]) { yield { type: "done" }; }),
    generateTitle: vi.fn(async () => null),
  };
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "user"); await next(); });
  app.route("/conversations", createDesktopToolRoutes(service as any));
  app.route("/conversations", createConversationRoutes(service as any));
  return { app, service };
}
const sessionPath = "/conversations/chat/desktop-tools/session";
const message = (app: ReturnType<typeof setup>["app"], headers: Record<string, string> = {}) => app.request("/conversations/chat/messages", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ content: "hello", clientType: "desktop", desktopTools: true }),
});
describe("local tool HTTP isolation", () => {
  it("rejects another user's conversation and specialized agents", async () => {
    expect((await setup("other").app.request(sessionPath, { method: "POST" })).status).toBe(404);
    expect((await setup("user", "ppt").app.request(sessionPath, { method: "POST" })).status).toBe(403);
  });
  it("plain web and spoofed desktop client flags do not enable tools", async () => {
    const { app, service } = setup();
    const response = await message(app, { "X-Client-Type": "desktop" });
    await response.text();
    expect(response.status).toBe(200);
    expect(service.streamAgentResponse.mock.calls[0][6]).not.toHaveProperty("desktopTools");
    expect((await message(app, { "X-Lot-Desktop-Capability": "forged" })).status).toBe(403);
  });
  it("binds a one-use capability to a chat turn and revokes at completion", async () => {
    const { app, service } = setup();
    const registration = await app.request(sessionPath, { method: "POST" });
    const { capability } = await registration.json() as { capability: string };
    expect(capability).toMatch(/^[a-f0-9]{64}$/);
    expect((await app.request(sessionPath)).status).toBe(404);
    const response = await message(app, { "X-Lot-Desktop-Capability": capability });
    await response.text();
    expect(response.status).toBe(200);
    expect(service.streamAgentResponse.mock.calls[0][6]).toHaveProperty("desktopTools");
    expect((await app.request(sessionPath, { headers: { "X-Lot-Desktop-Capability": capability } })).status).toBe(404);
    expect((await message(app, { "X-Lot-Desktop-Capability": capability })).status).toBe(403);
  });
  it("rejects forged result IDs and oversized result bodies", async () => {
    const { app } = setup();
    const request = (body: unknown) => app.request("/conversations/chat/desktop-tools/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await request({ id: "fake", result: { content: "fake success" } })).status).toBe(409);
    expect((await request({ id: "fake", result: { content: "x", errorKind: "untrusted" } })).status).toBe(400);
    expect((await request({ id: "fake", result: { content: "x".repeat(310000) } })).status).toBe(413);
  });
});
