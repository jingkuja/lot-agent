import { expect, it } from "vitest";
import { formatKnowledgeRecord } from "./knowledge-context.js";
import type { RagRecord } from "./rag-client.js";

it("passes neighboring source text and its own locator to the model, keeping the anchor intact", () => {
  const record: RagRecord = { datasetId: "kb", datasetName: "项目资料", segmentId: "middle", documentName: "合同", content: "付款期限十五天", answer: "", score: 0.03,
    evidence: { itemId: "item", revisionId: "rev", chunkId: "middle", collectionIds: ["kb"], title: "合同", content: "付款期限十五天", sourceType: "document", origin: "extracted_text", score: { kind: "rrf", value: 0.03 }, citation: { kind: "pdf", page: 2 },
      context: [{ chunkId: "before", position: "before", content: "需先验收", origin: "extracted_text", citation: { kind: "pdf", page: 1 } }, { chunkId: "after", position: "after", content: "争议时暂停付款", origin: "extracted_text", citation: { kind: "pdf", page: 3 } }] } };
  const text = formatKnowledgeRecord(record);
  expect(text.indexOf("需先验收")).toBeLessThan(text.indexOf("付款期限十五天"));
  expect(text.indexOf("付款期限十五天")).toBeLessThan(text.indexOf("争议时暂停付款"));
  expect(text).toContain('"chunkId":"before","citation":{"kind":"pdf","page":1}');
  expect(text).toContain('"chunkId":"after","citation":{"kind":"pdf","page":3}');
  expect(record.content).toBe("付款期限十五天");
});
