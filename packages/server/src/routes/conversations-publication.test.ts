import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createConversationRoutes } from "./conversations.js";

function setup(owner = "u1") {
  const db = {
    createConversation: vi.fn(async (...args) => ({ metadata: args[6] })),
    getConversation: vi.fn(async () => ({ user_id: owner, agent_id: "video" })),
    mergeConversationMetadata: vi.fn(async () => {}),
  };
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/conversations", createConversationRoutes({ db, llmConfig: { default: "openai", openai: { model: "test" } } } as any));
  return { app, db };
}
const publication = { copy: "开业", tags: "#探店" };
it("persists publication separately from the auto-generated title at creation", async () => {
  const { app } = setup();
  const res = await app.request("/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "video", videoPublication: publication }) });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ metadata: { videoPublication: publication } });
});
it("saves later publishing edits without submitting another generation", async () => {
  const { app, db } = setup();
  const res = await app.request("/conversations/c1/video-publication", { method: "PUT", body: JSON.stringify(publication) });
  expect(res.status).toBe(200);
  expect(db.mergeConversationMetadata).toHaveBeenCalledWith("c1", { videoPublication: publication });
});
it("rejects cross-account edits and malformed publication", async () => {
  const foreign = setup("other");
  expect((await foreign.app.request("/conversations/c1/video-publication", { method: "PUT", body: JSON.stringify(publication) })).status).toBe(404);
  expect(foreign.db.mergeConversationMetadata).not.toHaveBeenCalled();
  const own = setup();
  expect((await own.app.request("/conversations/c1/video-publication", { method: "PUT", body: JSON.stringify({ copy: "x", tags: [] }) })).status).toBe(400);
  expect(own.db.mergeConversationMetadata).not.toHaveBeenCalled();
});
