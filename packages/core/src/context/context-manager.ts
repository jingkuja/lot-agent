import type { Message, LLMProvider } from "../types/index.js";
import { estimateTokens } from "./tokenizer.js";
import { complete } from "../llm/complete.js";

/** Token budget allocation (in tokens) */
export interface TokenBudget {
  /** System prompt + skills. Default: 16K */
  systemPrompt: number;
  /** Summary of older conversation. Default: 4K */
  memory: number;
  /** Retrieved documents. Default: 20K */
  retrieval: number;
  /** Tool outputs in recent messages. Default: 20K */
  toolOutput: number;
  /**
   * Minimum reserved for recent conversation history. Default: 44K.
   * History is **elastic**: it expands to absorb whatever the window leaves
   * free (e.g. when there is no retrieval), and only shrinks toward this floor
   * when the other blocks are large.
   */
  history: number;
  /** Reserved for generation. 0 or omitted → derived from the leftover. */
  generation: number;
  /**
   * Total window size. Default: 120K — conservative enough for every model
   * currently wired up (Claude 200K, DeepSeek-class ~128K).
   */
  total: number;
}

const DEFAULT_BUDGET: TokenBudget = {
  systemPrompt: 16_000,
  memory: 4_000,
  retrieval: 20_000,
  toolOutput: 20_000,
  history: 44_000,
  generation: 0, // derived: total − the blocks above (16K with these defaults)
  total: 120_000,
};

/** Absolute lower bound for history so it never collapses to nothing. */
const MIN_HISTORY = 2_000;

/**
 * When compaction triggers, fold rounds until the kept tail is at or below
 * this fraction of the history budget (a low watermark). The resulting
 * headroom keeps the summary boundary — and thus the cached summary text and
 * the provider's prefix cache — stable while new rounds accumulate, instead
 * of moving the boundary (and re-summarizing) on every iteration.
 */
const COMPACT_RATIO = 0.6;

/** Cap on any single message's contribution to the summarization input. */
const SUMMARY_INPUT_MAX_CHARS = 4_000;

export interface ContextManagerConfig {
  budget?: Partial<TokenBudget>;
  /** Max raw message rounds to keep before summarizing. Default: 20 */
  maxRawRounds?: number;
  /** Compressor LLM (optional, uses same provider if omitted) */
  compressor?: LLMProvider;
  /**
   * Rolling summary carried over from a previous request (persisted by the
   * caller, e.g. in the conversation row) so an unchanged prefix is never
   * re-summarized across requests. Invalid/stale state is ignored.
   */
  initialSummary?: SummaryState;
}

/** Rolling summary covering the leading `count` messages of the history. */
export interface SummaryState {
  /** Number of leading history messages folded into `text`. */
  count: number;
  text: string;
}

export class ContextManager {
  private budget: TokenBudget;
  private maxRawRounds: number;
  private compressor?: LLMProvider;
  /**
   * Per-instance rolling summary. The Agent (and thus the ContextManager) is
   * built fresh per request, and `history` only grows at the tail across ReAct
   * iterations, so the summarized leading prefix is stable — we summarize each
   * round at most once and reuse the result on later iterations.
   */
  private summaryState?: SummaryState;

  constructor(config: ContextManagerConfig = {}) {
    this.budget = { ...DEFAULT_BUDGET, ...config.budget };
    // Reserve generation from the window. Honor an explicit positive value;
    // 0 or omitted means "derive the leftover", clamped so it never goes
    // negative when the configured sub-budgets over-subscribe the total.
    if (!config.budget?.generation) {
      this.budget.generation = Math.max(
        0,
        this.budget.total -
          this.budget.systemPrompt -
          this.budget.memory -
          this.budget.retrieval -
          this.budget.toolOutput -
          this.budget.history
      );
    }
    this.maxRawRounds = config.maxRawRounds ?? 20;
    this.compressor = config.compressor;
    if (config.initialSummary && config.initialSummary.count > 0) {
      this.summaryState = { ...config.initialSummary };
    }
  }

  getBudget(): TokenBudget {
    return { ...this.budget };
  }

  /** Current rolling-summary state, for the caller to persist across requests. */
  getSummaryState(): SummaryState | undefined {
    return this.summaryState ? { ...this.summaryState } : undefined;
  }

  /**
   * Elastic history budget: the window space left after the actually-used
   * system / memory / retrieval blocks and the reserved generation space.
   * Expands above the configured `history` floor when the window is free, and
   * shrinks toward `MIN_HISTORY` when the other blocks are large.
   */
  private historyBudget(
    systemTokens: number,
    memoryTokens: number,
    retrievalTokens = 0
  ): number {
    const elastic =
      this.budget.total -
      this.budget.generation -
      systemTokens -
      memoryTokens -
      retrievalTokens;
    // Never overflow the window even if the floor would push us past it.
    const hardCap = Math.max(
      0,
      this.budget.total - systemTokens - memoryTokens - retrievalTokens
    );
    return Math.min(hardCap, Math.max(MIN_HISTORY, this.budget.history, elastic));
  }

  /**
   * Count tokens in a message.
   */
  countMessageTokens(msg: Message): number {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content.map((p) => p.text ?? JSON.stringify(p)).join(" ");
    let tokens = estimateTokens(content);
    if (msg.toolCalls) {
      tokens += estimateTokens(JSON.stringify(msg.toolCalls));
    }
    if (msg.toolCallId) {
      tokens += 10; // overhead
    }
    return tokens + 4; // role/message overhead
  }

  /**
   * Count total tokens in a message array.
   */
  countTotalTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + this.countMessageTokens(m), 0);
  }

  /**
   * Assemble final messages for LLM call with budget management.
   * Structure (prefix-caching friendly):
   *   [system prompt] [memory/summary] [history (sliding window)] [current user message]
   */
  async assemble(
    systemParts: string[],
    memory: string | undefined,
    history: Message[],
    currentMessage?: Message,
    compressor?: LLMProvider,
    opts?: { signal?: AbortSignal }
  ): Promise<Message[]> {
    const result: Message[] = [];

    // 1. System prompt (fixed, prefix-cache friendly)
    const systemContent = systemParts.join("\n\n");
    let systemTokens = estimateTokens(systemContent);
    if (systemTokens > this.budget.systemPrompt) {
      // Truncate system prompt if too long
      const truncated = truncateToTokens(systemContent, this.budget.systemPrompt);
      result.push({ role: "system", content: truncated });
      systemTokens = estimateTokens(truncated);
    } else {
      result.push({ role: "system", content: systemContent });
    }

    // 2. Memory/summary (stable, prefix-cache friendly) — bounded by budget.
    let memoryTokens = 0;
    if (memory) {
      let memText = memory;
      if (estimateTokens(memText) > this.budget.memory) {
        memText = truncateToTokens(memText, this.budget.memory);
      }
      const content = `[Conversation Summary]\n${memText}`;
      memoryTokens = estimateTokens(content);
      result.push({ role: "system", content });
    }

    // 3. Recent history with elastic budget + rolling-summary compression.
    const historyBudget = this.historyBudget(systemTokens, memoryTokens);
    const recentHistory = await this.trimHistory(
      history,
      historyBudget,
      compressor ?? this.compressor,
      opts?.signal
    );
    result.push(...recentHistory);

    // 4. Current user message (optional — callers that keep it in `history`
    //    omit it to avoid duplicating the turn).
    if (currentMessage) result.push(currentMessage);

    return result;
  }

  /**
   * Trim history to `budget` tokens, cheapest strategy first:
   * 1. If history fits, return as-is.
   * 2. Elide tool outputs in all but the most recent round (zero-cost, no LLM
   *    call) — old tool outputs are the lowest-value, highest-volume content.
   * 3. Reuse the cached rolling summary while [summary + tail] still fits
   *    (sticky boundary). Otherwise fold whole rounds into the summary down to
   *    a low watermark (`COMPACT_RATIO`) so the boundary then stays put.
   * 4. Last resort (or no compressor): `truncateToFit` hard-guarantees the
   *    budget via per-message truncation and round dropping.
   */
  private async trimHistory(
    history: Message[],
    budget: number,
    compressor?: LLMProvider,
    signal?: AbortSignal
  ): Promise<Message[]> {
    // Fits in budget — return as-is.
    if (this.countTotalTokens(history) <= budget) {
      return history;
    }

    // Cheap pass: elide tool outputs outside the most recent round.
    const working = this.truncateOldToolOutputs(history);
    if (this.countTotalTokens(working) <= budget) {
      return working;
    }

    const rounds = this.splitIntoRounds(working);

    // Need a compressor to summarize; without one, fall back to truncation.
    if (compressor && rounds.length > 1) {
      const maxKept = Math.max(1, this.maxRawRounds);

      // Sticky boundary: while the cached summary plus the tail behind it
      // still fits, reuse it verbatim — no LLM call, stable prefix.
      const cached = this.summaryState;
      if (
        cached &&
        cached.count > 0 &&
        cached.count < working.length &&
        working[cached.count].role === "user" // still a round boundary
      ) {
        const tail = working.slice(cached.count);
        const candidate: Message[] = [
          { role: "system", content: `[Earlier Context]\n${cached.text}` },
          ...tail,
        ];
        if (
          this.countTotalTokens(candidate) <= budget &&
          this.splitIntoRounds(tail).length <= maxKept
        ) {
          return candidate;
        }
      }

      // Advance the boundary: peel whole rounds off the front until the kept
      // tail is at or below the low watermark (keeping at least the most
      // recent round verbatim), so later growth reuses the cached summary.
      const target = Math.max(MIN_HISTORY, budget * COMPACT_RATIO);
      let keepFrom = 0;
      const fits = (from: number) =>
        this.countTotalTokens(rounds.slice(from).flat()) <= target;
      while (
        keepFrom < rounds.length - 1 &&
        (!fits(keepFrom) || rounds.length - keepFrom > maxKept)
      ) {
        keepFrom++;
      }

      if (keepFrom > 0) {
        // Number of leading messages being summarized (round-aligned, so we
        // never split a user/assistant/tool group and orphan a tool result).
        const summarizedCount = rounds.slice(0, keepFrom).flat().length;
        const summary = await this.rollingSummary(
          working,
          summarizedCount,
          compressor,
          signal
        );
        const result: Message[] = [
          { role: "system", content: `[Earlier Context]\n${summary}` },
          ...rounds.slice(keepFrom).flat(),
        ];
        if (this.countTotalTokens(result) > budget) {
          return this.truncateToFit(result, budget);
        }
        return result;
      }
    }

    // No compressor (or a single huge round) — hard truncation.
    return this.truncateToFit(working, budget);
  }

  /**
   * Elide tool outputs in every round except the most recent one (whose
   * outputs the in-flight ReAct turn may still need). Zero LLM cost.
   */
  private truncateOldToolOutputs(history: Message[]): Message[] {
    const rounds = this.splitIntoRounds(history);
    if (rounds.length <= 1) return history;
    const lastRoundStart = history.length - rounds[rounds.length - 1].length;
    const maxToolTokens = Math.max(120, this.budget.toolOutput / 4);
    return history.map((m, i) => {
      if (i >= lastRoundStart || m.role !== "tool" || typeof m.content !== "string") {
        return m;
      }
      return { ...m, content: headTailTokens(m.content, maxToolTokens) };
    });
  }

  /**
   * Split flat message list into conversation rounds.
   * Each round: [user, (assistant, tool, tool_result, ..., assistant)]
   */
  private splitIntoRounds(messages: Message[]): Message[][] {
    const rounds: Message[][] = [];
    let current: Message[] = [];

    for (const msg of messages) {
      if (msg.role === "user" && current.length > 0) {
        rounds.push(current);
        current = [];
      }
      current.push(msg);
    }
    if (current.length > 0) {
      rounds.push(current);
    }
    return rounds;
  }

  /**
   * Return a summary covering the first `count` messages of `history`, reusing
   * the cached summary when the boundary is unchanged and extending it
   * incrementally when more rounds have aged out. Never re-summarizes from
   * scratch within a run.
   */
  private async rollingSummary(
    history: Message[],
    count: number,
    compressor: LLMProvider,
    signal?: AbortSignal
  ): Promise<string> {
    const cached = this.summaryState;
    if (cached && cached.count === count) {
      return cached.text; // boundary unchanged — reuse verbatim
    }
    const already = cached?.count ?? 0;
    // Boundary only moves forward across iterations; if it somehow moved back,
    // fold the requested prefix from scratch.
    const from = already < count ? already : 0;
    const priorSummary = from === already ? cached?.text : undefined;
    const newMessages = history.slice(from, count);
    const text = await this.summarize(newMessages, priorSummary, compressor, signal);
    this.summaryState = { count, text };
    return text;
  }

  /**
   * Summarize messages into a compact note, optionally extending a prior
   * rolling summary.
   */
  private async summarize(
    messages: Message[],
    priorSummary: string | undefined,
    compressor: LLMProvider,
    signal?: AbortSignal
  ): Promise<string> {
    const conversationText = messages
      .map((m) => {
        const content =
          typeof m.content === "string"
            ? m.content
            : m.content.map((p) => p.text ?? "").join(" ");
        const tools = m.toolCalls
          ? ` [tool_calls: ${m.toolCalls.map((c) => c.name).join(", ")}]`
          : "";
        // Cap each message's contribution so one huge message doesn't make
        // the summarization call itself expensive.
        return `${m.role}: ${headTail(content, SUMMARY_INPUT_MAX_CHARS)}${tools}`;
      })
      .join("\n");

    const system =
      "You maintain a running context note for an ongoing agent session. " +
      "Keep key facts, decisions, the user's original task/goal, user " +
      "requests, and important tool results. Preserve the original task " +
      "verbatim. Max 500 words. Output ONLY the updated note, no preamble.";
    const userParts = priorSummary
      ? `Existing note:\n${priorSummary}\n\nNew conversation to fold in:\n${conversationText}`
      : conversationText;

    return complete(
      compressor,
      [
        { role: "system", content: system },
        { role: "user", content: userParts },
      ],
      { signal }
    );
  }

  /**
   * Hard-guarantee `budget` via successive truncation passes: tool outputs,
   * then oversized user messages, then assistant prose, then dropping the
   * oldest whole rounds, then an equal per-message squeeze. Keeps the head
   * **and** tail of truncated bodies, and never removes `toolCalls` —
   * dropping them would orphan the paired tool result and make providers
   * reject the request.
   */
  private truncateToFit(messages: Message[], budget: number): Message[] {
    let totalTokens = this.countTotalTokens(messages);
    if (totalTokens <= budget) return messages;

    let result = messages.map((m) => ({ ...m }));
    // Per-message token cap derived from the tool-output budget (head+tail kept).
    const maxToolTokens = Math.max(120, this.budget.toolOutput / 4);

    // Pass 1: tool outputs — the largest savings — newest first.
    for (let i = result.length - 1; i >= 0 && totalTokens > budget; i--) {
      const msg = result[i];
      if (msg.role === "tool" && typeof msg.content === "string") {
        const before = this.countMessageTokens(msg);
        msg.content = headTailTokens(msg.content, maxToolTokens);
        totalTokens -= before - this.countMessageTokens(msg);
      }
    }

    // Pass 2: oversized user messages (e.g. pasted documents), oldest first.
    for (let i = 0; i < result.length && totalTokens > budget; i++) {
      const msg = result[i];
      if (msg.role === "user" && typeof msg.content === "string") {
        const before = this.countMessageTokens(msg);
        msg.content = headTailTokens(msg.content, maxToolTokens);
        totalTokens -= before - this.countMessageTokens(msg);
      }
    }

    // Pass 3: verbose assistant prose, but KEEP toolCalls.
    for (let i = result.length - 1; i >= 0 && totalTokens > budget; i--) {
      const msg = result[i];
      if (
        msg.role === "assistant" &&
        typeof msg.content === "string" &&
        msg.content.length > 200
      ) {
        const before = this.countMessageTokens(msg);
        msg.content = msg.content.slice(0, 200) + "...(truncated)";
        totalTokens -= before - this.countMessageTokens(msg);
      }
    }

    // Pass 4: drop the oldest whole rounds (round-aligned so no tool result
    // is orphaned), keeping leading system notes and at least the newest round.
    if (totalTokens > budget) {
      let lead = 0;
      while (lead < result.length && result[lead].role === "system") lead++;
      const leading = result.slice(0, lead);
      const rounds = this.splitIntoRounds(result.slice(lead));
      const note: Message = {
        role: "system",
        content: "[Earlier messages dropped to fit the context window]",
      };
      const noteTokens = this.countMessageTokens(note);
      let drop = 0;
      while (drop < rounds.length - 1 && totalTokens + noteTokens > budget) {
        totalTokens -= this.countTotalTokens(rounds[drop]);
        drop++;
      }
      if (drop > 0) {
        result = [...leading, note, ...rounds.slice(drop).flat()];
        totalTokens = this.countTotalTokens(result);
      }
    }

    // Pass 5: a single round can still be over — squeeze every text body to
    // an equal per-message share.
    if (totalTokens > budget) {
      const share = Math.max(50, Math.floor(budget / result.length) - 8);
      for (const msg of result) {
        if (typeof msg.content === "string" && msg.content) {
          const ratio =
            msg.content.length / Math.max(1, estimateTokens(msg.content));
          msg.content = headTail(
            msg.content,
            Math.max(40, Math.floor(share * ratio))
          );
        }
      }
    }

    return result;
  }
}

/**
 * Truncate `text` so its estimated tokens fit `maxTokens`, appending a marker.
 * Char budget is derived from the text's own chars-per-token density (CJK ≈ 1
 * char/token, ASCII ≈ 3.5), then tightened until the estimate actually fits.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  const contentBudget = Math.max(1, maxTokens - 8); // leave room for the marker
  if (estimateTokens(text) <= contentBudget) return text;
  const ratio = text.length / Math.max(1, estimateTokens(text));
  let chars = Math.floor(contentBudget * ratio);
  let cut = text.slice(0, chars);
  while (chars > 1 && estimateTokens(cut) > contentBudget) {
    chars = Math.floor(chars * 0.9);
    cut = text.slice(0, chars);
  }
  return cut + "\n...(truncated)";
}

/**
 * Head+tail elision bounded by a token budget: the char cap is derived from
 * the text's own chars-per-token density (CJK ≈ 1, ASCII ≈ 3.5).
 */
function headTailTokens(text: string, maxTokens: number): string {
  const ratio = text.length / Math.max(1, estimateTokens(text));
  return headTail(text, Math.max(400, Math.floor(maxTokens * ratio)));
}

/** Keep the head and tail of a long string, eliding the middle. */
function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.floor(maxChars / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(text.length - keep);
  return `${head}\n...(elided ${text.length - 2 * keep} chars)...\n${tail}`;
}
