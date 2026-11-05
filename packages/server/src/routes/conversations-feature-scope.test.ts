import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createConversationRoutes } from "./conversations.js";
import { createDigitalEmployeeExtension } from "../digital-employee/agent.js";
import { registerAgentExtension } from "../services/agent-extensions.js";

registerAgentExtension(createDigitalEmployeeExtension());

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

describe("conversation list filters", () => {
  it("forwards agentId and includePreview to listConversations", async () => {
    const listConversations = vi.fn(async () => []);
    const service = { db: { listConversations } } as any;
    const instance = new Hono<{ Variables: { userId: string } }>();
    instance.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
    instance.route("/conversations", createConversationRoutes(service));
    const res = await instance.request("/conversations?limit=20&agentId=image&includePreview=1");
    expect(res.status).toBe(200);
    expect(listConversations).toHaveBeenCalledWith("u1", {
      agentId: "image",
      includePreview: true,
      limit: 20,
      cursorId: undefined,
    });
  });
});

describe("conversation feature scope", () => {
  it("stores every new digital employee conversation as employee, whatever the client sends", async () => {
    for (const featureScope of [undefined, "customer-acquisition", "all"]) {
      const { instance, createConversation } = app();
      const response = await instance.request("/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "digital_employee", featureScope }),
      });
      expect(response.status).toBe(201);
      expect(createConversation).toHaveBeenCalledWith(
        expect.any(String), "新对话", undefined, undefined, "digital_employee", "u1",
        { digitalEmployeeFeatureScope: "employee" }, undefined
      );
    }
  });

  it("uses the configured mini program LLM when X-Lot-Client is miniprogram", async () => {
    const { instance, createConversation } = app();
    const response = await instance.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lot-client": "miniprogram" },
      body: JSON.stringify({ title: "新对话", agentId: "image" }),
    });
    expect(response.status).toBe(201);
    expect(createConversation).toHaveBeenCalledWith(
      expect.any(String), "新对话", "deepseek-v4.1-flash", "openai", "image", "u1", undefined, undefined
    );
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
