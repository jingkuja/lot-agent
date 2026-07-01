import { describe, it, expect } from "vitest";
import { ContextManager } from "./context-manager.js";
import { estimateTokens } from "./tokenizer.js";
import type {
  ChatChunk,
  ChatOptions,
  LLMProvider,
  LLMTool,
  Message,
} from "../types/index.js";

/** Compressor that records how many times it was invoked. */
class FakeCompressor implements LLMProvider {
  calls = 0;
  lastUserContent = "";
  lastSignal?: AbortSignal;
  constructor(private reply: string = "SUMMARY") {}
  async *chat(
    messages: Message[],
    _tools?: LLMTool[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk> {
    this.calls++;
    this.lastSignal = opts?.signal;
    const last = messages[messages.length - 1];
    this.lastUserContent =
      typeof last.content === "string" ? last.content : "";
    yield { type: "text", content: this.reply };
    yield { type: "done", finishReason: "stop" };
  }
}

/** Compressor that fails the test if it is ever called. */
class ThrowingCompressor implements LLMProvider {
  async *chat(): AsyncIterable<ChatChunk> {
    throw new Error("compressor should not have been called");
  }
}

/** Build a string of roughly `tokens` estimated tokens (ASCII ≈ 3.5 chars/token). */
function textOfTokens(tokens: number): string {
  return "x".repeat(Math.ceil(tokens * 3.5));
}

function userMsg(tokens: number): Message {
  return { role: "user", content: textOfTokens(tokens) };
}
function assistantMsg(tokens: number): Message {
  return { role: "assistant", content: textOfTokens(tokens) };
}

describe("ContextManager budget", () => {
  it("clamps generation to non-negative when sub-budgets exceed total", () => {
    const cm = new ContextManager({
      budget: { total: 10_000, systemPrompt: 8_000, retrieval: 60_000 },
    });
    expect(cm.getBudget().generation).toBeGreaterThanOrEqual(0);
  });

  it("history budget is elastic: keeps history above the configured `history` floor when window is free", async () => {
    // configured history floor is 30K, but total window leaves far more free.
    const cm = new ContextManager({
      budget: { total: 200_000, history: 30_000, generation: 8_000 },
    });
    // ~50K of history — over the old fixed 30K cap, but well within the window.
    const history: Message[] = [userMsg(25_000), assistantMsg(25_000)];
    // ThrowingCompressor proves no summarization/compaction happens.
    const out = await cm.assemble([], undefined, history, undefined, new ThrowingCompressor());
    const historyOut = out.filter((m) => m.role !== "system");
    expect(cm.countTotalTokens(historyOut)).toBeGreaterThan(45_000);
  });

  it("truncates memory to the memory budget", async () => {
    const cm = new ContextManager({ budget: { memory: 1_000 } });
    const memory = textOfTokens(5_000);
    const out = await cm.assemble([], memory, [], undefined);
    const memMsg = out.find(
      (m) => m.role === "system" && String(m.content).includes("Summary")
    );
    expect(memMsg).toBeDefined();
    expect(estimateTokens(String(memMsg!.content))).toBeLessThanOrEqual(1_200);
  });
});

describe("ContextManager truncation correctness", () => {
  it("never deletes toolCalls, so no tool result is orphaned", async () => {
    const cm = new ContextManager({
      budget: { total: 20_000, history: 4_000, generation: 2_000 },
    });
    // A single round with a big tool output that blows the budget, no compressor.
    const history: Message[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "t1", name: "search", arguments: {} }],
      },
      { role: "tool", toolCallId: "t1", content: textOfTokens(10_000) },
      { role: "assistant", content: "done" },
    ];
    const out = await cm.assemble([], undefined, history, undefined);
    // Every tool result must still have a preceding assistant with a matching toolCall id.
    const open = new Set<string>();
    for (const m of out) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const c of m.toolCalls) open.add(c.id);
      }
      if (m.role === "tool" && m.toolCallId) {
        expect(open.has(m.toolCallId)).toBe(true);
      }
    }
  });

  it("keeps the tail of a truncated tool output (not just the head)", async () => {
    const cm = new ContextManager({
      budget: { total: 20_000, history: 4_000, generation: 2_000 },
    });
    const head = "HEAD_MARKER";
    const tail = "TAIL_MARKER";
    const big = head + "y".repeat(40_000) + tail;
    const history: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "t1", name: "x", arguments: {} }],
      },
      { role: "tool", toolCallId: "t1", content: big },
    ];
    const out = await cm.assemble([], undefined, history, undefined);
    const toolOut = out.find((m) => m.role === "tool");
    expect(String(toolOut!.content)).toContain(tail);
  });
});

describe("ContextManager incremental summary", () => {
  it("triggers summarization on token overflow even with few rounds", async () => {
    const cm = new ContextManager({
      budget: { total: 30_000, history: 6_000, generation: 4_000 },
      maxRawRounds: 20,
    });
    const compressor = new FakeCompressor();
    // 3 rounds, each large — under maxRawRounds but over the token budget.
    const history: Message[] = [
      userMsg(8_000),
      assistantMsg(8_000),
      userMsg(8_000),
      assistantMsg(8_000),
      userMsg(1_000),
      assistantMsg(1_000),
    ];
    const out = await cm.assemble([], undefined, history, undefined, compressor);
    expect(compressor.calls).toBeGreaterThan(0);
    expect(
      out.some((m) => String(m.content).includes("SUMMARY"))
    ).toBe(true);
  });

  it("forwards the abort signal to the compressor", async () => {
    const cm = new ContextManager({
      budget: { total: 30_000, history: 6_000, generation: 4_000 },
    });
    const compressor = new FakeCompressor();
    const controller = new AbortController();
    const history: Message[] = [
      userMsg(8_000),
      assistantMsg(8_000),
      userMsg(8_000),
      assistantMsg(8_000),
    ];
    await cm.assemble([], undefined, history, undefined, compressor, {
      signal: controller.signal,
    });
    expect(compressor.calls).toBeGreaterThan(0);
    expect(compressor.lastSignal).toBe(controller.signal);
  });

  it("reuses the cached summary when the overflow boundary has not moved", async () => {
    // Tight token budget forces summarization; maxRawRounds stays non-binding
    // so the overflow boundary is set by tokens and holds when a tiny round is
    // appended at the tail.
    const cm = new ContextManager({
      budget: { total: 20_000, history: 2_000, generation: 4_000 },
      maxRawRounds: 20,
    });
    const compressor = new FakeCompressor();
    const base: Message[] = [
      userMsg(5_000),
      assistantMsg(5_000),
      userMsg(2_000),
      assistantMsg(2_000),
      userMsg(2_000),
      assistantMsg(2_000),
    ];
    await cm.assemble([], undefined, base, undefined, compressor);
    const afterFirst = compressor.calls;
    expect(afterFirst).toBeGreaterThan(0);

    // Append a fresh recent round; the older summarized prefix is unchanged.
    const grown = [...base, userMsg(500), assistantMsg(500)];
    await cm.assemble([], undefined, grown, undefined, compressor);
    // No new summarization call — the cached prefix summary is reused.
    expect(compressor.calls).toBe(afterFirst);
  });
});
