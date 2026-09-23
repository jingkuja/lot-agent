import { describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";

function service(source: "remote" | "local") {
  const local = { listCollections: vi.fn(async () => [{ id: "local", name: "资料", description: "", storedCount: 2, searchableCount: 1 }]) };
  return {
    knowledge: { source, service: local },
    ragIdentity: vi.fn(async () => ({ externalUserId: "external", name: "user" })),
    ragClient: { listKnowledgeBases: vi.fn(async () => []), createKnowledgeBaseLink: vi.fn(async () => "https://remote"), retrieve: vi.fn(async () => []) },
    listKnowledgeBases: AgentService.prototype.listKnowledgeBases,
    createKnowledgeBaseLink: AgentService.prototype.createKnowledgeBaseLink,
    retrieveKnowledge: AgentService.prototype.retrieveKnowledge,
  };
}
describe("AgentService knowledge source", () => {
  it("preserves remote listing, links and retrieval", async () => {
    const s = service("remote");
    await s.listKnowledgeBases("u1");
    await expect(s.createKnowledgeBaseLink("u1")).resolves.toBe("https://remote");
    await s.retrieveKnowledge("u1", [{ id: "a", name: "A" }], "query");
    expect(s.ragClient.retrieve).toHaveBeenCalledWith({ externalUserId: "external", name: "user" }, ["a"], "query");
    expect(s.knowledge.service.listCollections).not.toHaveBeenCalled();
  });
  it("maps local counts and never requests remote identity, links or retrieval", async () => {
    const s = service("local");
    await expect(s.listKnowledgeBases("u1")).resolves.toEqual([{ id: "local", name: "资料", description: "", documentCount: 2, availableDocumentCount: 1 }]);
    await expect(s.createKnowledgeBaseLink("u1")).rejects.toMatchObject({ status: 503 });
    await expect(s.retrieveKnowledge("u1", [{ id: "old-id", name: "old" }], "query")).rejects.toMatchObject({ status: 503 });
    expect(s.ragIdentity).not.toHaveBeenCalled();
    expect(s.ragClient.retrieve).not.toHaveBeenCalled();
    expect(s.ragClient.createKnowledgeBaseLink).not.toHaveBeenCalled();
  });
  it("propagates local failures without remote fallback", async () => {
    const s = service("local");
    s.knowledge.service.listCollections.mockRejectedValueOnce(new Error("unavailable"));
    await expect(s.listKnowledgeBases("u1")).rejects.toThrow("unavailable");
    expect(s.ragClient.listKnowledgeBases).not.toHaveBeenCalled();
  });
});
