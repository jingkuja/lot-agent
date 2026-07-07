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

/** Compressor that simulates an LLM call failing (e.g. retries exhausted). */
class FailingCompressor implements LLMProvider {
  calls = 0;
  async *chat(): AsyncIterable<ChatChunk> {
    this.calls++;
    throw new Error("503 upstream unavailable");
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

/** Build a CJK string of roughly `tokens` estimated tokens (1 char/token). */
function cjkTextOfTokens(tokens: number): string {
  return "中".repeat(tokens);
}

describe("ContextManager budget", () => {
  it("clamps generation to non-negative when sub-budgets exceed total", () => {
    const cm = new ContextManager({
      budget: { total: 10_000, systemPrompt: 8_000, retrieval: 60_000 },
    });
    expect(cm.getBudget().generation).toBeGreaterThanOrEqual(0);
  });

  it("treats an explicit generation: 0 as 'derive from leftover'", () => {
    // config/default.json historically shipped generation: 0 — that must not
    // disable the output reserve.
    const cm = new ContextManager({
      budget: { total: 120_000, generation: 0 },
    });
    expect(cm.getBudget().generation).toBeGreaterThan(0);
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

describe("ContextManager retrieval block", () => {
  it("injects a [Retrieved Context] system block after the summary, before history", async () => {
    const cm = new ContextManager();
    const history: Message[] = [{ role: "user", content: "question" }];
    const out = await cm.assemble([], "prior summary", history, undefined, undefined, {
      retrieval: "fact: the sky is blue",
    });

    const retrievalIdx = out.findIndex(
      (m) => m.role === "system" && String(m.content).includes("[Retrieved Context]")
    );
    const summaryIdx = out.findIndex(
      (m) => m.role === "system" && String(m.content).includes("Summary")
    );
    const historyIdx = out.findIndex((m) => m.role === "user");

    expect(retrievalIdx).toBeGreaterThan(summaryIdx);
    expect(retrievalIdx).toBeLessThan(historyIdx);
    expect(String(out[retrievalIdx].content)).toContain("the sky is blue");
  });

  it("truncates retrieval to the retrieval budget", async () => {
    const cm = new ContextManager({ budget: { retrieval: 1_000 } });
    const out = await cm.assemble([], undefined, [], undefined, undefined, {
      retrieval: textOfTokens(5_000),
    });
    const retrieved = out.find(
      (m) => m.role === "system" && String(m.content).includes("[Retrieved Context]")
    );
    expect(retrieved).toBeDefined();
    expect(estimateTokens(String(retrieved!.content))).toBeLessThanOrEqual(1_200);
  });

  it("adds no block when no retrieval is supplied (backward compatible)", async () => {
    const cm = new ContextManager();
    const out = await cm.assemble([], undefined, [{ role: "user", content: "hi" }]);
    expect(out.some((m) => String(m.content).includes("[Retrieved Context]"))).toBe(false);
  });
});

describe("ContextManager CJK truncation", () => {
  // CJK text estimates at ~1 token/char (vs 3.5 chars/token for ASCII), so a
  // char budget derived with the ASCII ratio would overshoot the token budget
  // by ~3.5x.

  it("truncates a CJK system prompt to the systemPrompt token budget", async () => {
    const cm = new ContextManager({ budget: { systemPrompt: 1_000 } });
    const out = await cm.assemble([cjkTextOfTokens(5_000)], undefined, []);
    const sysMsg = out[0];
    expect(sysMsg.role).toBe("system");
    expect(estimateTokens(String(sysMsg.content))).toBeLessThanOrEqual(1_100);
  });

  it("truncates CJK memory to the memory token budget", async () => {
    const cm = new ContextManager({ budget: { memory: 1_000 } });
    const out = await cm.assemble([], cjkTextOfTokens(5_000), []);
    const memMsg = out.find(
      (m) => m.role === "system" && String(m.content).includes("Summary")
    );
    expect(memMsg).toBeDefined();
    expect(estimateTokens(String(memMsg!.content))).toBeLessThanOrEqual(1_100);
  });

  it("truncates a CJK tool output near the per-output token cap", async () => {
    // toolOutput budget 2_000 → per-output cap ~500 tokens. CJK content must
    // land near that cap, not 3.5x over it.
    const cm = new ContextManager({
      budget: { total: 20_000, history: 2_000, generation: 2_000, toolOutput: 2_000 },
    });
    const history: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "t1", name: "x", arguments: {} }],
      },
      { role: "tool", toolCallId: "t1", content: cjkTextOfTokens(20_000) },
    ];
    const out = await cm.assemble([], undefined, history, undefined);
    const toolMsg = out.find((m) => m.role === "tool");
    expect(estimateTokens(String(toolMsg!.content))).toBeLessThanOrEqual(700);
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

describe("ContextManager oversized-message safety", () => {
  it("truncates an oversized single user message to fit the history budget", async () => {
    // elastic history budget = 20K - 2K generation = 18K
    const cm = new ContextManager({
      budget: { total: 20_000, history: 2_000, generation: 2_000 },
    });
    const history: Message[] = [userMsg(50_000)];
    const out = await cm.assemble([], undefined, history, undefined);
    const kept = out.filter((m) => m.role !== "system");
    expect(kept.length).toBe(1);
    expect(cm.countTotalTokens(kept)).toBeLessThanOrEqual(18_000);
    // head+tail elision, not a silent pass-through
    expect(String(kept[0].content)).toContain("elided");
  });

  it("drops oldest rounds as a last resort so output always fits the budget", async () => {
    // elastic history budget = 8K - 4K generation = 4K; per-output cap 200 tokens —
    // 10 capped rounds still exceed 4K, forcing whole-round dropping.
    const cm = new ContextManager({
      budget: { total: 8_000, generation: 4_000, history: 2_000, toolOutput: 800 },
    });
    const history: Message[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(
        { role: "user", content: textOfTokens(300) },
        {
          role: "assistant",
          content: "c",
          toolCalls: [{ id: `t${i}`, name: "x", arguments: {} }],
        },
        { role: "tool", toolCallId: `t${i}`, content: textOfTokens(3_000) },
        { role: "assistant", content: "done" }
      );
    }
    const out = await cm.assemble([], undefined, history, undefined);
    expect(cm.countTotalTokens(out)).toBeLessThanOrEqual(4_100);
    // tool pairing must survive the round dropping
    const openIds = new Set(
      out.flatMap((m) =>
        m.role === "assistant" && m.toolCalls ? m.toolCalls.map((c) => c.id) : []
      )
    );
    for (const m of out) {
      if (m.role === "tool" && m.toolCallId) {
        expect(openIds.has(m.toolCallId)).toBe(true);
      }
    }
    // the most recent round survives
    expect(out[out.length - 1].role).toBe("assistant");
  });
});

describe("ContextManager compression strategy", () => {
  it("elides old tool outputs before resorting to the compressor", async () => {
    // elastic budget 32K; the old round's 40K tool output alone overflows it,
    // but cheap head+tail elision fixes that without an LLM call.
    const cm = new ContextManager({
      budget: { total: 40_000, generation: 8_000, history: 2_000, toolOutput: 4_000 },
    });
    const compressor = new FakeCompressor();
    const history: Message[] = [
      { role: "user", content: "round1" },
      {
        role: "assistant",
        content: "c",
        toolCalls: [{ id: "t1", name: "x", arguments: {} }],
      },
      { role: "tool", toolCallId: "t1", content: textOfTokens(40_000) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "round2" },
      {
        role: "assistant",
        content: "c",
        toolCalls: [{ id: "t2", name: "x", arguments: {} }],
      },
      { role: "tool", toolCallId: "t2", content: "RECENT_TOOL_OUTPUT" },
      { role: "assistant", content: "ok" },
    ];
    const out = await cm.assemble([], undefined, history, undefined, compressor);
    expect(compressor.calls).toBe(0);
    const tools = out.filter((m) => m.role === "tool");
    expect(String(tools[0].content)).toContain("elided");
    expect(String(tools[1].content)).toBe("RECENT_TOOL_OUTPUT");
  });

  it("compacts to a low watermark so the boundary stays put as history grows", async () => {
    // elastic budget 16K; 8 rounds × ~2.5K overflow it.
    const cm = new ContextManager({
      budget: { total: 20_000, history: 2_000, generation: 4_000 },
      maxRawRounds: 20,
    });
    const compressor = new FakeCompressor();
    const base: Message[] = [];
    for (let i = 0; i < 8; i++) base.push(userMsg(1_250), assistantMsg(1_250));
    const first = await cm.assemble([], undefined, base, undefined, compressor);
    const keptTokens = cm.countTotalTokens(
      first.filter((m) => m.role !== "system")
    );
    // compacted to the ~60% watermark, not just barely under the 16K budget
    expect(keptTokens).toBeLessThanOrEqual(9_600);
    const callsAfterFirst = compressor.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // two full new rounds fit inside the headroom → no new summary call
    const grown = [
      ...base,
      userMsg(1_250),
      assistantMsg(1_250),
      userMsg(1_250),
      assistantMsg(1_250),
    ];
    await cm.assemble([], undefined, grown, undefined, compressor);
    expect(compressor.calls).toBe(callsAfterFirst);
  });

  it("caps each message's contribution to the summarization input", async () => {
    const cm = new ContextManager({
      budget: { total: 20_000, history: 2_000, generation: 4_000 },
    });
    const compressor = new FakeCompressor();
    const history: Message[] = [
      userMsg(30_000), // ~105K chars — must not be fed to the compressor whole
      assistantMsg(100),
      userMsg(100),
      assistantMsg(100),
    ];
    await cm.assemble([], undefined, history, undefined, compressor);
    expect(compressor.calls).toBeGreaterThan(0);
    expect(compressor.lastUserContent.length).toBeLessThanOrEqual(10_000);
  });

  it("degrades to hard truncation instead of throwing when the compressor call fails", async () => {
    const cm = new ContextManager({
      budget: { total: 20_000, history: 2_000, generation: 4_000 },
      maxRawRounds: 20,
    });
    const compressor = new FailingCompressor();
    const base: Message[] = [];
    for (let i = 0; i < 8; i++) base.push(userMsg(1_250), assistantMsg(1_250));

    const out = await cm.assemble([], undefined, base, undefined, compressor);

    expect(compressor.calls).toBeGreaterThan(0);
    // No cached summary was produced — the failure must not be persisted as state.
    expect(cm.getSummaryState()).toBeUndefined();
    // Still within budget via truncation, and the most recent round survives.
    expect(cm.countTotalTokens(out)).toBeLessThanOrEqual(
      cm.getBudget().history + cm.getBudget().systemPrompt
    );
    expect(out[out.length - 1].role).toBe("assistant");
  });

  it("propagates a compressor failure caused by cancellation instead of degrading", async () => {
    const cm = new ContextManager({
      budget: { total: 20_000, history: 2_000, generation: 4_000 },
      maxRawRounds: 20,
    });
    const controller = new AbortController();
    controller.abort();
    const compressor = new FailingCompressor();
    const base: Message[] = [];
    for (let i = 0; i < 8; i++) base.push(userMsg(1_250), assistantMsg(1_250));

    await expect(
      cm.assemble([], undefined, base, undefined, compressor, {
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});

describe("ContextManager summary persistence", () => {
  it("exposes the rolling summary and reuses it across instances", async () => {
    const budget = { total: 20_000, history: 2_000, generation: 4_000 };
    const base: Message[] = [];
    for (let i = 0; i < 8; i++) base.push(userMsg(1_250), assistantMsg(1_250));

    const cm1 = new ContextManager({ budget });
    const compressor1 = new FakeCompressor();
    await cm1.assemble([], undefined, base, undefined, compressor1);
    const state = cm1.getSummaryState();
    expect(state).toBeDefined();
    expect(state!.count).toBeGreaterThan(0);
    expect(state!.text).toBe("SUMMARY");

    // A fresh instance (next request) seeded with the persisted state must not
    // re-summarize the unchanged prefix.
    const cm2 = new ContextManager({ budget, initialSummary: state });
    const compressor2 = new FakeCompressor();
    const out = await cm2.assemble([], undefined, base, undefined, compressor2);
    expect(compressor2.calls).toBe(0);
    expect(out.some((m) => String(m.content).includes("SUMMARY"))).toBe(true);
  });

  it("ignores an invalid persisted summary state", async () => {
    const budget = { total: 20_000, history: 2_000, generation: 4_000 };
    const cm = new ContextManager({
      budget,
      initialSummary: { count: 999, text: "STALE" },
    });
    const compressor = new FakeCompressor();
    const base: Message[] = [];
    for (let i = 0; i < 8; i++) base.push(userMsg(1_250), assistantMsg(1_250));
    const out = await cm.assemble([], undefined, base, undefined, compressor);
    expect(compressor.calls).toBeGreaterThan(0); // re-summarized from scratch
    expect(out.some((m) => String(m.content).includes("STALE"))).toBe(false);
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
