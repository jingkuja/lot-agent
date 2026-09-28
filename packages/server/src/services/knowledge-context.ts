import type { RagRecord } from "./rag-client.js";

/** Include original context with separate locators, never a generated summary or fabricated range. */
export function formatKnowledgeRecord(record: RagRecord): string {
  const evidence = record.evidence;
  const context = (position: "before" | "after") => evidence?.context?.filter((chunk) => chunk.position === position).map((chunk) =>
    `[相邻原文；证据: ${JSON.stringify({ itemId: evidence.itemId, revisionId: evidence.revisionId, chunkId: chunk.chunkId, citation: chunk.citation })}]\n${chunk.content}`) ?? [];
  const anchor = `${evidence ? `[证据: ${JSON.stringify({ itemId: evidence.itemId, revisionId: evidence.revisionId, chunkId: evidence.chunkId, citation: evidence.citation })}]\n` : ""}${record.content}`;
  return `[知识库: ${record.datasetName}]${record.documentName ? ` [文档: ${record.documentName}]` : ""} [排序分数: ${record.score.toFixed(4)}]\n` +
    [...context("before"), anchor, ...context("after")].join("\n") + (record.answer ? `\n参考答案: ${record.answer}` : "");
}
