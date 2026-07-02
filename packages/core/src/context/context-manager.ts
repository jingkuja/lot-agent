import type { Message, LLMProvider } from "../types/index.js";
import { estimateTokens } from "./tokenizer.js";

/** Token budget allocation (in tokens) */
export interface TokenBudget {
  /** System prompt + skills. Default: 80K */
  systemPrompt: number;
  /** Summary of older conversation. Default: 4K */
  memory: number;
  /** Retrieved documents. Default: 60K */
  retrieval: number;
  /** Tool outputs in recent messages. Default: 20K */
  toolOutput: number;
  /**
   * Minimum reserved for recent conversation history. Default: 30K.
   * History is **elastic**: it expands to absorb whatever the window leaves
   * free (e.g. when there is no retrieval), and only shrinks toward this floor
   * when the other blocks are large.
   */
  history: number;
  /** Reserved for generation. Default: remaining */
  generation: number;
  /** Total window size */
  total: number;
}

const DEFAULT_BUDGET: TokenBudget = {
  systemPrompt: 8_0000,
  memory: 14_000,
  retrieval: 50_000,
  toolOutput: 20_000,
  history: 30_000,
  generation: 0, // computed
  total: 280_000,
};

/** Absolute lower bound for history so it never collapses to nothing. */
const MIN_HISTORY = 2_000;

export interface ContextManagerConfig {
  budget?: Partial<TokenBudget>;
  /** Max raw message rounds to keep before summarizing. Default: 20 */
  maxRawRounds?: number;
  /** Compressor LLM (optional, uses same provider if omitted) */
  compressor?: LLMProvider;
}

/** Cached rolling summary covering the leading `count` messages of the run. */
interface SummaryState {
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
    // Reserve generation from the window. Honor an explicit value; otherwise
    // derive the leftover, clamped so it never goes negative when the
    // configured sub-budgets over-subscribe the total.
    if (config.budget?.generation === undefined) {
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
  }

  getBudget(): TokenBudget {
    return { ...this.budget };
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
      const truncated =
        systemContent.slice(0, charsForTokens(this.budget.systemPrompt)) +
        "\n...(truncated)";
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
        memText =
          memText.slice(0, charsForTokens(this.budget.memory)) +
          "\n...(truncated)";
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
   * Trim history to `budget` tokens using a sliding window + rolling summary.
   * - If history fits, return as-is.
   * - Otherwise fold the oldest whole rounds into a rolling summary until the
   *   remainder fits (summary is cached/extended across iterations).
   * - If still too long (or no compressor), truncate tool outputs.
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

    const rounds = this.splitIntoRounds(history);

    // Need a compressor to summarize; without one, fall back to truncation.
    if (compressor && rounds.length > 1) {
      // Peel whole rounds off the front until the kept tail fits, always
      // keeping at least the most recent round verbatim. Honor `maxRawRounds`
      // as an upper bound on how many raw rounds we keep.
      let keepFrom = 0;
      const fits = (from: number) =>
        this.countTotalTokens(rounds.slice(from).flat()) <= budget;
      const maxKept = Math.max(1, this.maxRawRounds);
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
          history,
          summarizedCount,
          compressor,
          signal
        );
        const result: Message[] = [
          { role: "system", content: `[Earlier Context]\n${summary}` },
          ...rounds.slice(keepFrom).flat(),
        ];
        if (this.countTotalTokens(result) > budget) {
          return this.truncateToolOutputs(result, budget);
        }
        return result;
      }
    }

    // No compressor (or a single huge round) — truncate tool outputs.
    return this.truncateToolOutputs(history, budget);
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
        return `${m.role}: ${content}${tools}`;
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

    let summary = "";
    for await (const chunk of compressor.chat(
      [
        { role: "system", content: system },
        { role: "user", content: userParts },
      ],
      undefined,
      { signal }
    )) {
      if (chunk.type === "text") summary += chunk.content;
    }
    return summary;
  }

  /**
   * Truncate tool outputs (and, as a last resort, assistant text) to fit
   * `budget`. Keeps the head **and** tail of each tool output, and never
   * removes `toolCalls` — dropping them would orphan the paired tool result
   * and make providers reject the request.
   */
  private truncateToolOutputs(messages: Message[], budget: number): Message[] {
    let totalTokens = this.countTotalTokens(messages);
    if (totalTokens <= budget) return messages;

    const result = messages.map((m) => ({ ...m }));
    // Per-output cap derived from the tool-output budget (head+tail kept).
    const maxToolChars = Math.max(400, charsForTokens(this.budget.toolOutput) / 4);

    // Work backwards, truncating the largest savings first: tool messages.
    for (let i = result.length - 1; i >= 0; i--) {
      if (totalTokens <= budget) break;
      const msg = result[i];
      if (msg.role === "tool" && typeof msg.content === "string") {
        const before = this.countMessageTokens(msg);
        msg.content = headTail(msg.content, maxToolChars);
        totalTokens -= before - this.countMessageTokens(msg);
      }
    }

    // Still over budget — shorten verbose assistant prose, but KEEP toolCalls.
    if (totalTokens > budget) {
      for (let i = result.length - 1; i >= 0; i--) {
        if (totalTokens <= budget) break;
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
    }

    return result;
  }
}

/** Approximate char budget for a token budget (inverse of the estimator). */
function charsForTokens(tokens: number): number {
  return Math.floor(tokens * 3.5);
}

/** Keep the head and tail of a long string, eliding the middle. */
function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.floor(maxChars / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(text.length - keep);
  return `${head}\n...(elided ${text.length - 2 * keep} chars)...\n${tail}`;
}
