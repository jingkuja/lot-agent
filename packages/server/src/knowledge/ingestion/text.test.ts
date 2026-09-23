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
