import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "./conversations.js";

function fakeService(metadata: Record<string, unknown> = {}) {
  const mergeConversationMetadata = vi.fn(async () => {});
  const resolveKnowledgeBases = vi.fn(async (_userId: string, ids: string[]) =>
    ids.map((id) => ({ id, name: `知识库 ${id}` }))
  );
  return {
    db: {
      getConversation: vi.fn(async () => ({
        id: "c1",
        user_id: "u1",
        agent_id: "general",
        metadata,
      })),
      mergeConversationMetadata,
      claimConversationRun: vi.fn(async () => true),
      releaseConversationRun: vi.fn(async () => {}),
      getAsset: vi.fn(async () => null),
    },
    resolveKnowledgeBases,
    streamAgentResponse: vi.fn(async function* () {
      yield { type: "done", totalTokens: 0, inputTokens: 0, outputTokens: 0 };
    }),
    generateTitle: vi.fn(async () => null),
  } as any;
}

function app(service: any) {
  const instance = new Hono<{ Variables: { userId: string } }>();
  instance.use("*", async (c, next) => {
    c.set("userId", "u1");
    await next();
  });
  instance.route("/conversations", createConversationRoutes(service));
  return instance;
}

describe("conversation knowledge-base persistence", () => {
  it("persists a confirmed selection immediately", async () => {
    const service = fakeService();
    const response = await app(service).request("/conversations/c1/knowledge-bases", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ knowledgeBaseIds: ["kb1", "kb2"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      knowledgeBases: [
        { id: "kb1", name: "知识库 kb1", sourceTypes: ["document", "note"] },
        { id: "kb2", name: "知识库 kb2", sourceTypes: ["document", "note"] },
      ],
    });
    expect(service.db.mergeConversationMetadata).toHaveBeenCalledWith("c1", {
      knowledgeBases: [
        { id: "kb1", name: "知识库 kb1", sourceTypes: ["document", "note"] },
        { id: "kb2", name: "知识库 kb2", sourceTypes: ["document", "note"] },
      ],
    });
  });

  it("keeps using the conversation selection when a message omits ids", async () => {
    const service = fakeService({
      knowledgeBases: [{ id: "kb1", name: "已保存名称" }],
    });
    const response = await app(service).request("/conversations/c1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "继续问" }),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(service.resolveKnowledgeBases).toHaveBeenCalledWith("u1", ["kb1"], "remote");
    expect(service.streamAgentResponse.mock.calls[0][6]).toEqual({
      modelId: undefined,
      knowledgeBases: [{ id: "kb1", name: "知识库 kb1", sourceTypes: ["document", "note"] }],
    });
    expect(service.db.mergeConversationMetadata).not.toHaveBeenCalled();
  });

  it("preserves explicit local source when resending the same selected IDs", async () => {
    const service = fakeService({ knowledgeBases: [{ id: "kb1", name: "Local", source: "local" }] });
    const response = await app(service).request("/conversations/c1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "继续", knowledgeBaseIds: ["kb1"] }) });
    await response.text();
    expect(service.resolveKnowledgeBases).toHaveBeenCalledWith("u1", ["kb1"], "local");
  });
  it("persists explicitly selected types and restores them on the next message", async () => {
    const selection = { id: "kb1", name: "Local", source: "local", sourceTypes: ["bookmark", "image", "profile_fact"] };
    const service = fakeService({ knowledgeBases: [selection] });
    const put = await app(service).request("/conversations/c1/knowledge-bases", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ knowledgeBaseIds: ["kb1"], knowledgeSourceTypes: selection.sourceTypes }) });
    expect(put.status).toBe(200); expect((await put.json() as { knowledgeBases: Array<{ sourceTypes: string[] }> }).knowledgeBases[0].sourceTypes).toEqual(selection.sourceTypes);
    const response = await app(service).request("/conversations/c1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "引用说明" }) });
    await response.text(); expect(service.streamAgentResponse.mock.calls[0][6].knowledgeBases[0].sourceTypes).toEqual(selection.sourceTypes);
    const invalid = await app(service).request("/conversations/c1/knowledge-bases", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ knowledgeBaseIds: ["kb1"], knowledgeSourceTypes: ["unknown"] }) });
    expect(invalid.status).toBe(400);
  });
  it("treats an explicit empty selection as manual removal", async () => {
    const service = fakeService({
      knowledgeBases: [{ id: "kb1", name: "已保存名称" }],
    });
    const response = await app(service).request("/conversations/c1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "不再使用知识库", knowledgeBaseIds: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(service.resolveKnowledgeBases).not.toHaveBeenCalled();
    expect(service.db.mergeConversationMetadata).toHaveBeenCalledWith("c1", {
      knowledgeBases: [],
    });
    expect(service.streamAgentResponse.mock.calls[0][6]).toEqual({
      modelId: undefined,
      knowledgeBases: [],
    });
  });
});
