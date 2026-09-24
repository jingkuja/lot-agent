import type { KnowledgeCitation, KnowledgeOrigin } from "@lot-agent/core";
export interface ParsedBlock { text: string; citation?: KnowledgeCitation; origin: KnowledgeOrigin }
export interface TokenCounter { count(text: string): number }
export interface TextChunk extends ParsedBlock { overlapCharacters: number; tokenCount: number }
export const MAX_EXTRACTED_CHARACTERS = 2_000_000;

export function textBlocks(text: string): ParsedBlock[] {
  if (!text.trim()) throw new Error("EMPTY_TEXT");
  if (text.length > MAX_EXTRACTED_CHARACTERS || text.includes("\u0000") || text.includes("\ufffd")) throw new Error("INVALID_TEXT");
  return text.split(/\r?\n/).flatMap((line, index) => line.trim() ? [{ text: line, citation: { kind: "text" as const, startLine: index + 1, endLine: index + 1 }, origin: "extracted_text" as const }] : []);
}

/** Split without truncation using the supplied budget counter. A byte counter is a
 * conservative candidate budget, not an assertion of the model token count. */
export function splitBlocks(blocks: ParsedBlock[], tokenizer: TokenCounter, maxTokens: number, overlapTokens: number, pack = false): TextChunk[] {
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || !Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) throw new Error("INVALID_TOKEN_BUDGET");
  if (pack) {
    if (!blocks.length) throw new Error("EMPTY_TEXT");
    return packBlocks(blocks, tokenizer, maxTokens, overlapTokens);
  }
  const result: TextChunk[] = [];
  const count = (s: string) => {
    const value = tokenizer.count(s);
    if (!Number.isInteger(value) || value < 0) throw new Error("INVALID_TOKENIZER");
    return value;
  };
  for (const block of blocks) {
    const chars = Array.from(block.text); let start = 0; let overlapCharacters = 0;
    while (start < chars.length) {
      // UTF-8 bytes are an upper bound for standard byte-tokenizer token counts;
      // the measured candidate is still checked and shrunk for any injected tokenizer.
      let end = Math.min(chars.length, start + maxTokens);
      while (end > start && count(chars.slice(start, end).join("")) > maxTokens) end--;
      if (end === start) throw new Error("TOKEN_EXCEEDS_BUDGET");
      const text = chars.slice(start, end).join("");
      result.push({ ...block, text, tokenCount: count(text), overlapCharacters });
      if (result.length > 20000) throw new Error("TOO_MANY_CHUNKS");
      if (end === chars.length) break;
      let next = end;
      while (next > start + 1 && count(chars.slice(next - 1, end).join("")) <= overlapTokens) next--;
      overlapCharacters = end - next; start = next;
    }
  }
  if (!result.length) throw new Error("EMPTY_TEXT");
  return result;
}

/** Pack neighboring text/paragraphs, keeping page, heading and origin boundaries.
 * Map each chunk back to the blocks it actually overlaps, including overlap text. */
function packBlocks(blocks: ParsedBlock[], counter: TokenCounter, budget: number, overlap: number): TextChunk[] {
  const groups: ParsedBlock[][] = [];
  for (const block of blocks) {
    const group = groups.at(-1); const previous = group?.at(-1);
    const a = previous?.citation; const b = block.citation;
    const compatible = previous?.origin === block.origin && (
      a?.kind === "text" && b?.kind === "text" && a.endLine < b.startLine ||
      a?.kind === "docx" && b?.kind === "docx" && a.heading === b.heading && a.paragraph < b.paragraph ||
      a?.kind === "pdf" && b?.kind === "pdf" && a.page === b.page || !a && !b);
    if (group && compatible) group.push(block); else groups.push([block]);
  }
  return groups.flatMap((group) => {
    let offset = 0;
    const ranges = group.map((block) => { const start = offset; offset += Array.from(block.text).length + 1; return { start, end: offset - 1, citation: block.citation }; });
    const joined = { ...group[0], text: group.map((b) => b.text).join("\n") };
    let start = 0; let first = 0;
    return splitBlocks([joined], counter, budget, overlap).map((chunk) => {
      start -= chunk.overlapCharacters;
      const end = start + Array.from(chunk.text).length;
      while (first + 1 < ranges.length && ranges[first].end <= start) first++;
      let last = first;
      while (last + 1 < ranges.length && ranges[last + 1].start < end) last++;
      const a = ranges[first].citation; const b = ranges[last].citation;
      const citation = a?.kind === "text" && b?.kind === "text" ? { ...a, endLine: b.endLine }
        : a?.kind === "docx" && b?.kind === "docx" ? { ...a, endParagraph: b.endParagraph ?? b.paragraph } : a;
      start = end;
      return { ...chunk, citation };
    });
  });
}
