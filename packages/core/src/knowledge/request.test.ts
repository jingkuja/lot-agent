import { describe, expect, it } from "vitest";
import { parseKnowledgeRetrievalRequest } from "./request.js";

const valid = { query: " 离线模式？ ", collection_ids: ["kb"] };
describe("knowledge retrieval contract", () => {
  it("defaults only absent values and excludes facts/media by default", () => {
    expect(parseKnowledgeRetrievalRequest(valid)).toEqual({
      query: "离线模式？", collectionIds: ["kb"], topK: 5, mode: "hybrid",
      sourceTypes: ["document", "note"], tags: [], allowDegraded: false,
    });
    expect(parseKnowledgeRetrievalRequest({ ...valid, allow_degraded: true }).allowDegraded).toBe(true);
  });
  it.each([
    { collection_ids: [] }, { collection_ids: ["kb", "kb"] },
    { collection_ids: Array.from({ length: 11 }, (_, i) => String(i)) },
    { collection_ids: [""] }, { collection_ids: [" kb"] },
    { query: " " }, { query: "😀".repeat(2001) }, { query: null },
    { top_k: 0 }, { top_k: 21 }, { top_k: 1.5 }, { top_k: null },
    { allow_degraded: "false" }, { allow_degraded: null }, { mode: "auto" },
    { filters: { owner: "victim" } }, { user_id: "victim" },
    { filters: { source_types: [] } }, { filters: { source_types: ["unknown"] } },
    { filters: { tags: [""] } },
  ])("rejects invalid/unknown input %j", (input) => {
    expect(() => parseKnowledgeRetrievalRequest({ ...valid, ...input })).toThrow();
  });
  it("counts Unicode characters and accepts explicit keyword/fact scope", () => {
    const result = parseKnowledgeRetrievalRequest({ ...valid, query: "😀".repeat(2000),
      mode: "keyword", top_k: 20, filters: { source_types: ["profile_fact"], tags: ["产品"] } });
    expect(result.sourceTypes).toEqual(["profile_fact"]);
    expect(result.mode).toBe("keyword");
  });
});
