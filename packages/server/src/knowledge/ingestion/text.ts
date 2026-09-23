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
export function splitBlocks(blocks: ParsedBlock[], tokenizer: TokenCounter, maxTokens: number, overlapTokens: number): TextChunk[] {
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || !Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) throw new Error("INVALID_TOKEN_BUDGET");
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
