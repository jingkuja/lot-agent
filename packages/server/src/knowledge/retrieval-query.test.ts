import { expect, it } from "vitest";
import { retrievalQuery } from "./retrieval-query.js";

it("removes question boilerplate while keeping Chinese content words", () => {
  const query = retrievalQuery("请问差旅报销需要哪些材料？");
  expect(query.terms).toContain("报销");
  expect(query.terms).toContain("材料");
  expect(query.terms).not.toContain("请问");
  expect(query.terms).not.toContain("哪些");
  expect(query.terms).not.toContain("需要");
});

it("normalizes and preserves explicit identifiers and years as required constraints", () => {
  const query = retrievalQuery("请查 ＡＢ－１２３ 和 ZX9 在2026年的付款条件");
  expect(query.identifiers).toEqual(expect.arrayContaining(["ab-123", "zx9", "2026"]));
  expect(query.identifierPatterns[query.identifiers.indexOf("ab-123")]).toBe("(^|[^a-z0-9_.-])ab-123([^a-z0-9_.-]|$)");
});

it("produces no broad lexical search from only punctuation or question boilerplate", () => {
  expect(retrievalQuery("？请问一下").terms).toEqual([]);
  expect(retrievalQuery("%_|'\\").terms).toEqual([]);
});

it("escapes identifier punctuation for SQL regular expressions and deduplicates terms", () => {
  const query = retrievalQuery("v1.2 v1.2");
  expect(query.identifiers).toEqual(["v1.2"]);
  expect(query.identifierPatterns[0]).toContain("v1\\.2");
  expect(new Set(query.terms).size).toBe(query.terms.length);
});
