import type { Message, LLMProvider } from "../types/index.js";
import { estimateTokens } from "./tokenizer.js";

/** Token budget allocation (in tokens) */
export interface TokenBudget {
  /** System prompt + skills. Default: 8K */
  systemPrompt: number;
  /** Summary of older conversation. Default: 4K */
  memory: number;
  /** Retrieved documents. Default: 60K */
  retrieval: number;
  /** Tool outputs in recent messages. Default: 20K */
  toolOutput: number;
  /** Recent conversation history. Default: 30K */
  history: number;
  /** Reserved for generation. Default: remaining */
  generation: number;
  /** Total window size */
  total: number;
}

const DEFAULT_BUDGET: TokenBudget = {
  systemPrompt: 8_000,
  memory: 4_000,
  retrieval: 60_000,
  toolOutput: 20_000,
  history: 30_000,
  generation: 0, // computed
  total: 200_000,
};

export interface ContextManagerConfig {
  budget?: Partial<TokenBudget>;
  /** Max raw message rounds to keep before summarizing. Default: 20 */
  maxRawRounds?: number;
  /** Compressor LLM (optional, uses same provider if omitted) */
  compressor?: LLMProvider;
}

export class ContextManager {
  private budget: TokenBudget;
  private maxRawRounds: number;
  private compressor?: LLMProvider;

  constructor(config: ContextManagerConfig = {}) {
    this.budget = { ...DEFAULT_BUDGET, ...config.budget };
    this.budget.generation =
      this.budget.total -
      this.budget.systemPrompt -
      this.budget.memory -
      this.budget.retrieval -
      this.budget.toolOutput -
      this.budget.history;
    this.maxRawRounds = config.maxRawRounds ?? 20;
    this.compressor = config.compressor;
  }

  getBudget(): TokenBudget {
    return { ...this.budget };
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
    currentMessage: Message,
    compressor?: LLMProvider
  ): Promise<Message[]> {
    const result: Message[] = [];

    // 1. System prompt (fixed, prefix-cache friendly)
    const systemContent = systemParts.join("\n\n");
    const systemTokens = estimateTokens(systemContent);
    if (systemTokens > this.budget.systemPrompt) {
      // Truncate system prompt if too long
      const truncated =
        systemContent.slice(
          0,
          Math.floor(this.budget.systemPrompt * 3.5)
        ) + "\n...(truncated)";
      result.push({ role: "system", content: truncated });
    } else {
      result.push({ role: "system", content: systemContent });
    }

    // 2. Memory/summary (stable, prefix-cache friendly)
    if (memory) {
      result.push({
        role: "system",
        content: `[Conversation Summary]\n${memory}`,
      });
    }

    // 3. Recent history with sliding window
    const recentHistory = await this.trimHistory(
      history,
      compressor ?? this.compressor
    );
    result.push(...recentHistory);

    // 4. Current user message
    result.push(currentMessage);

    return result;
  }

  /**
   * Trim history using sliding window + summary compression.
   * - If history fits in budget, return as-is
   * - If too many rounds, summarize older ones and return summary + recent
   * - If still too long, truncate tool outputs in older messages
   */
  private async trimHistory(
    history: Message[],
    compressor?: LLMProvider
  ): Promise<Message[]> {
    const historyTokens = this.countTotalTokens(history);

    // Fits in budget — return as-is
    if (historyTokens <= this.budget.history) {
      return history;
    }

    // Split into rounds (user → assistant pairs)
    const rounds = this.splitIntoRounds(history);

    // If too many rounds, summarize the overflow
    if (rounds.length > this.maxRawRounds && compressor) {
      const overflowRounds = rounds.slice(
        0,
        rounds.length - this.maxRawRounds
      );
      const recentRounds = rounds.slice(
        rounds.length - this.maxRawRounds
      );

      // Summarize overflow rounds
      const overflowMessages = overflowRounds.flat();
      const summary = await this.summarize(overflowMessages, compressor);

      // Rebuild: summary as system message + recent rounds
      const result: Message[] = [
        { role: "system", content: `[Earlier Context]\n${summary}` },
        ...recentRounds.flat(),
      ];

      // If still too long, truncate tool outputs in older recent rounds
      if (this.countTotalTokens(result) > this.budget.history) {
        return this.truncateToolOutputs(result);
      }
      return result;
    }

    // No compressor available or fewer rounds than threshold — truncate tool outputs
    return this.truncateToolOutputs(history);
  }

  /**
   * Split flat message list into conversation rounds.
   * Each round: [user, (tool, tool_result, ..., assistant)]
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
   * Summarize messages into a compact text using LLM.
   */
  private async summarize(
    messages: Message[],
    compressor: LLMProvider
  ): Promise<string> {
    const conversationText = messages
      .map((m) => {
        const content =
          typeof m.content === "string"
            ? m.content
            : m.content.map((p) => p.text ?? "").join(" ");
        return `${m.role}: ${content}`;
      })
      .join("\n");

    let summary = "";
    for await (const chunk of compressor.chat([
      {
        role: "system",
        content:
          "Summarize the following conversation into a concise context note. " +
          "Keep key facts, decisions, user requests, and tool results. " +
          "Max 500 words. Output ONLY the summary, no preamble.",
      },
      { role: "user", content: conversationText },
    ])) {
      if (chunk.type === "text") summary += chunk.content;
    }
    return summary;
  }

  /**
   * Truncate tool outputs in older messages to save tokens.
   * Keeps the last 500 chars of each tool output.
   */
  private truncateToolOutputs(messages: Message[]): Message[] {
    let totalTokens = this.countTotalTokens(messages);
    if (totalTokens <= this.budget.history) return messages;

    const result = messages.map((m) => ({ ...m }));
    const MAX_TOOL_OUTPUT = 500;

    // Work backwards, truncate tool messages first
    for (let i = result.length - 1; i >= 0; i--) {
      if (totalTokens <= this.budget.history) break;
      const msg = result[i];
      if (msg.role === "tool" && typeof msg.content === "string") {
        const oldTokens = estimateTokens(msg.content);
        if (msg.content.length > MAX_TOOL_OUTPUT) {
          msg.content =
            msg.content.slice(0, MAX_TOOL_OUTPUT) +
            `\n...(truncated from ${msg.content.length} chars)`;
          const newTokens = estimateTokens(msg.content);
          totalTokens -= oldTokens - newTokens;
        }
      }
    }

    // If still over budget, truncate assistant messages with tool calls
    if (totalTokens > this.budget.history) {
      for (let i = result.length - 1; i >= 0; i--) {
        if (totalTokens <= this.budget.history) break;
        const msg = result[i];
        if (msg.role === "assistant" && typeof msg.content === "string" && msg.toolCalls) {
          const oldTokens = estimateTokens(msg.content);
          if (msg.content.length > 200) {
            msg.content = msg.content.slice(0, 200) + "...(truncated)";
            const newTokens = estimateTokens(msg.content);
            totalTokens -= oldTokens - newTokens;
          }
          // Remove tool calls metadata to save tokens
          delete msg.toolCalls;
          totalTokens -= 50; // approximate savings
        }
      }
    }

    return result;
  }
}
