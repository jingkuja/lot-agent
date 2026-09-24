import { describe, expect, it } from "vitest";
import { KnowledgeUuidSchema, parseKnowledgeRetrievalRequest } from "@lot-agent/core";
import { validateRequest, contract } from "./contract-fixture.js";
const base = { query: "离线资料", collection_ids: ["00000000-0000-4000-8000-000000000001"] };
const accepts = (input: unknown) => { try { parseKnowledgeRetrievalRequest(input).collectionIds.forEach((id) => KnowledgeUuidSchema.parse(id)); return true; } catch { return false; } };
describe("published OpenAPI retrieval contract", () => {
  it("matches runtime validation for meaningful boundaries and rejects owner injection", () => {
    const cases = [base, { ...base, top_k: 1, allow_degraded: false }, { ...base, query: "字".repeat(2000) },
      { ...base, query: "𠮷".repeat(2000) }, { ...base, query: "𠮷".repeat(2001) }, { ...base, query: "" },
      { ...base, top_k: 0 }, { ...base, top_k: 21 }, { ...base, top_k: 1.5 }, { ...base, collection_ids: [] },
      { ...base, collection_ids: [...base.collection_ids, ...base.collection_ids] }, { ...base, collection_ids: ["remote-id"] },
      { ...base, owner_id: "another user" }, { ...base, filters: { tags: ["a", "b"] } },
      { ...base, filters: { source_types: ["note", "profile_fact"] } }, { ...base, filters: { unknown: true } }, { ...base, mode: "automatic" }];
    for (const input of cases) expect(validateRequest(input), JSON.stringify(input).slice(0, 100)).toBe(accepts(input));
  });
  it("publishes only the supported standard routes with independent bearer security", () => {
    expect(Object.keys(contract.paths).sort()).toEqual(["/assets/{id}/content", "/collections", "/items/{id}", "/profile", "/retrieval"]);
    expect(contract.security).toEqual([{ KnowledgeKey: [] }]);
    expect(JSON.stringify(contract)).not.toContain("dify");
  });
});
