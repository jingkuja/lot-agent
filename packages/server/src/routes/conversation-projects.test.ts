import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "./conversations.js";

function setup(owner = "u1", ownsProject = true) {
  const db = {
    getConversation: vi.fn(async () => ({ id: "c1", user_id: owner })),
    ownsConversationProject: vi.fn(async () => ownsProject),
    setConversationProject: vi.fn(async (_id, _user, project_id) => ({ id: "c1", project_id })),
    createConversationProject: vi.fn(async (_id, user_id, name) => ({ user_id, name })),
    listConversations: vi.fn(async () => []),
    createConversation: vi.fn(async (...args: unknown[]) => ({ id: args[0], project_id: args[7] })),
  };
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/", createConversationRoutes({ db, llmConfig: { default: "openai", openai: { model: "test" } } } as any));
  const move = (body: unknown) => app.request("/c1/project", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { app, db, move };
}

describe("conversation projects", () => {
  it("creates a trimmed project owned by the signed-in user", async () => {
    const { app, db } = setup();
    const response = await app.request("/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: " 项目一 " }) });
    expect(response.status).toBe(201);
    expect(db.createConversationProject).toHaveBeenCalledWith(expect.any(String), "u1", "项目一");
  });
  it.each(["", " ", "x".repeat(81), 123])("rejects invalid project name %s", async (name) => {
    const { app, db } = setup();
    expect((await app.request("/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })).status).toBe(400);
    expect(db.createConversationProject).not.toHaveBeenCalled();
  });
  it("blocks moving another user's conversation", async () => {
    const { move, db } = setup("u2");
    expect((await move({ projectId: "p1" })).status).toBe(404);
    expect(db.setConversationProject).not.toHaveBeenCalled();
  });
  it("blocks another user's project", async () => {
    const { move, db, app } = setup("u1", false);
    expect((await move({ projectId: "p2" })).status).toBe(404);
    expect((await app.request("/projects/p2/conversations")).status).toBe(404);
    expect(db.setConversationProject).not.toHaveBeenCalled();
    expect(db.listConversations).not.toHaveBeenCalled();
  });
  it("creates a conversation inside an owned project", async () => {
    const { app, db } = setup();
    const response = await app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "p1" }) });
    expect(response.status).toBe(201);
    expect(db.createConversation).toHaveBeenCalledWith(expect.any(String), "新对话", "test", "openai", "general", "u1", undefined, "p1");
  });
  it("rejects creating a conversation inside an inaccessible project", async () => {
    const { app, db } = setup("u1", false);
    const response = await app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "p2" }) });
    expect(response.status).toBe(404);
    expect(db.createConversation).not.toHaveBeenCalled();
  });
  it("moves a conversation back to recent", async () => {
    const { move, db } = setup();
    expect((await move({ projectId: null })).status).toBe(200);
    expect(db.setConversationProject).toHaveBeenCalledWith("c1", "u1", null);
  });
  it("rejects a missing project selection", async () => {
    const { move } = setup();
    expect((await move({})).status).toBe(400);
  });
  it("loads all project conversations scoped by owner", async () => {
    const { app, db } = setup();
    expect((await app.request("/projects/p1/conversations")).status).toBe(200);
    expect(db.listConversations).toHaveBeenCalledWith("u1", { projectId: "p1" });
  });
});
