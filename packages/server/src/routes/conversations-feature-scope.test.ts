import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createConversationRoutes } from "./conversations.js";

function app() {
  const createConversation = vi.fn(async (_id, title, model, provider, agentId, userId, metadata) => ({
    id: "c1", title, model, provider, agent_id: agentId, user_id: userId, metadata: metadata ?? {},
  }));
  const service = {
    llmConfig: { default: "openai", openai: { model: "test-model" }, anthropic: { model: "test-anthropic" } },
    db: { createConversation },
  } as any;
  const instance = new Hono<{ Variables: { userId: string } }>();
  instance.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  instance.route("/conversations", createConversationRoutes(service));
  return { instance, createConversation };
}

describe("conversation feature scope", () => {
  it("persists a valid digital employee scope on creation", async () => {
    const { instance, createConversation } = app();
    const response = await instance.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "digital_employee", featureScope: "customer-acquisition" }),
    });
    expect(response.status).toBe(201);
    expect(createConversation).toHaveBeenCalledWith(
      expect.any(String), "新对话", "test-model", "openai", "digital_employee", "u1",
      { digitalEmployeeFeatureScope: "customer-acquisition" }
    );
  });

  it("rejects digital employee conversations without a legal featureScope", async () => {
    const { instance, createConversation } = app();
    const missing = await instance.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "digital_employee" }),
    });
    const invalid = await instance.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "digital_employee", featureScope: "all" }),
    });
    expect(missing.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("does not persist a feature scope for another agent", async () => {
    const { instance, createConversation } = app();
    await instance.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "general", featureScope: "customer-acquisition" }),
    });
    expect(createConversation.mock.calls[0][6]).toBeUndefined();
  });

  it("refuses to stream a digital employee conversation that has no legal scope", async () => {
    const getConversation = vi.fn(async () => ({
      id: "c1", user_id: "u1", agent_id: "digital_employee", metadata: {},
    }));
    const streamAgentResponse = vi.fn(async function* () {});
    const service = {
      llmConfig: { default: "openai", openai: { model: "test-model" }, anthropic: { model: "test-anthropic" } },
      db: { getConversation },
      streamAgentResponse,
    } as any;
    const instance = new Hono<{ Variables: { userId: string } }>();
    instance.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
    instance.route("/conversations", createConversationRoutes(service));

    const response = await instance.request("/conversations/c1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "今天该跟谁" }),
    });
    expect(response.status).toBe(400);
    expect(streamAgentResponse).not.toHaveBeenCalled();
  });
});
