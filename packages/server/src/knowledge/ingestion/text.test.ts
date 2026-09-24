import { expect, it } from "vitest";
import { textBlocks, splitBlocks } from "./text.js";
it("preserves all text beyond 30K and real source lines without fabricating pages", () => {
  const text = Array.from({ length: 1000 }, (_, i) => `第${i}段 产品型号 AB-123 中文说明。`).join("\n");
  const blocks = textBlocks(text);
  expect(blocks.at(-1)?.citation).toEqual({ kind: "text", startLine: 1000, endLine: 1000 });
  expect(blocks.at(-1)?.text).toContain("第999段");
});
it("splits by an injected model tokenizer budget and preserves Unicode text", () => {
  const text = "中文😀".repeat(300);
  const tokenizer = { count: (s: string) => Array.from(s).length };
  const chunks = splitBlocks(textBlocks(text), tokenizer, 80, 10);
  expect(chunks.every((chunk) => tokenizer.count(chunk.text) <= 80)).toBe(true);
  expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk.text))).toBe(true);
  let restored = chunks[0].text;
  for (const chunk of chunks.slice(1)) restored += Array.from(chunk.text).slice(chunk.overlapCharacters).join("");
  expect(restored).toBe(text);
});
it("rejects empty text, invalid budgets and pathological tokenizer results", () => {
  expect(() => textBlocks(" \n\n")).toThrow();
  expect(() => splitBlocks(textBlocks("hello"), { count: () => 10 }, 5, 1)).toThrow();
  expect(() => splitBlocks(textBlocks("hello"), { count: (s) => s.length }, 5, 5)).toThrow();
});
it("packs adjacent short lines with exact locators and bounded overlap", () => {
  const chunks = splitBlocks(textBlocks("AB-123\n支持离线查看"), { count: (s) => Buffer.byteLength(s) }, 512, 64, true);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ text: "AB-123\n支持离线查看", citation: { kind: "text", startLine: 1, endLine: 2 } });
  const many = splitBlocks(textBlocks(Array(2001).fill("a").join("\n")), { count: (s) => Buffer.byteLength(s) }, 512, 64, true);
  expect(many.length).toBeLessThan(20);
  expect(many.at(-1)?.citation).toMatchObject({ endLine: 2001 });
  expect(splitBlocks(textBlocks("a\nb"), { count: (s) => s.length }, 512, 64)).toHaveLength(2);
});
it("never merges different PDF pages or origins", () => {
  const chunks = splitBlocks([{ text: "a", origin: "extracted_text", citation: { kind: "pdf", page: 1 } }, { text: "b", origin: "extracted_text", citation: { kind: "pdf", page: 2 } }], { count: (s) => s.length }, 512, 64, true);
  expect(chunks).toHaveLength(2);
});

it("maps packed DOCX paragraphs and Unicode overlap to their actual source ranges", () => {
  const chunks = splitBlocks([{ text: "甲😀".repeat(100), origin: "extracted_text", citation: { kind: "docx", paragraph: 2, heading: "标题" } }, { text: "乙😀".repeat(100), origin: "extracted_text", citation: { kind: "docx", paragraph: 3, heading: "标题" } }], { count: (s) => Buffer.byteLength(s) }, 512, 64, true);
  expect(chunks.some((c) => c.citation?.kind === "docx" && c.citation.paragraph === 2 && c.citation.endParagraph === 3)).toBe(true);
  expect(chunks.at(-1)?.citation).toMatchObject({ paragraph: 3, endParagraph: 3 });
  let restored = chunks[0].text;
  for (const chunk of chunks.slice(1)) restored += Array.from(chunk.text).slice(chunk.overlapCharacters).join("");
  expect(restored).toBe("甲😀".repeat(100) + "\n" + "乙😀".repeat(100));
  expect(() => splitBlocks([], { count: (s) => s.length }, 512, 64, true)).toThrow("EMPTY_TEXT");
});
