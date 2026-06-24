import type {
  Message,
  ContentPart,
  LLMProvider,
  ToolCall,
  ToolContext,
  ToolResult,
} from "../types/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { ContextManager, type ContextManagerConfig } from "../context/index.js";
import type { AgentMemoryStore } from "../memory/index.js";

/** Events emitted during agent execution */
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "done"; iterations: number; totalTokens: number; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string }
  | { type: "artifact"; assetId: string; url: string; mediaType: string };

export interface AgentConfig {
  maxIterations: number;
  /** Wall-clock timeout for the entire agent run in ms. Default: 300000 (5 min) */
  maxRunTimeMs: number;
  systemPrompt: string;
  dynamicPromptParts?: string[];
  contextConfig?: ContextManagerConfig;
  /** Optional whitelist of tool names this agent is allowed to use. Undefined = all tools. */
  allowedToolNames?: string[];
}

export interface AgentContext {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  memory?: AgentMemoryStore;
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 20,
  maxRunTimeMs: 300_000, // 5 minutes
  systemPrompt: "You are a helpful AI assistant.",
};

/** Order-independent JSON serialization, so {a,b} and {b,a} dedup the same. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export class Agent {
  private config: AgentConfig;
  private contextManager: ContextManager;

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.contextManager = new ContextManager(this.config.contextConfig);
  }

  async *run(
    userMessage: string | ContentPart[],
    context: AgentContext,
    history: Message[] = []
  ): AsyncIterable<AgentEvent> {
    // Clear ephemeral memory at the start of each run
    context.memory?.clearEphemeral();

    // Build system prompt parts
    const systemParts = [this.config.systemPrompt];
    if (this.config.dynamicPromptParts?.length) {
      systemParts.push(...this.config.dynamicPromptParts);
    }

    // Inject memory into system prompt
    if (context.memory) {
      const memoryPrompt = context.memory.formatForPrompt();
      if (memoryPrompt) {
        systemParts.push(memoryPrompt);
      }

      // Also load user memory (async)
      const userEntries = await context.memory.listUserMemory();
      if (userEntries.length > 0) {
        const userMem = userEntries
          .map((e) => `- ${e.key}: ${e.value}`)
          .join("\n");
        systemParts.push(`[User Memory]\n${userMem}`);
      }
    }

    const tools = context.toolRegistry.toLLMTools(this.config.allowedToolNames);
    let iterations = 0;
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // Working message log (accumulates during this run)
    const workingHistory: Message[] = [...history];
    const runStartTime = Date.now();

    // Dedup successful tool calls within this run: a model that re-issues an
    // identical call (same name + args) reuses the prior result instead of
    // re-executing — prevents wasteful repeats (e.g. generating the same
    // document multiple times). Failed calls are NOT cached, so the model can
    // still retry after a transient failure (e.g. web_search timing out).
    const successfulCalls = new Map<string, ToolResult>();

    while (iterations < this.config.maxIterations) {
      // Wall-clock timeout check
      if (Date.now() - runStartTime > this.config.maxRunTimeMs) {
        yield {
          type: "error",
          message: `Agent run timed out after ${Math.round(this.config.maxRunTimeMs / 1000)}s`,
        };
        yield { type: "done", iterations, totalTokens, inputTokens, outputTokens };
        return;
      }

      iterations++;
      let hasToolCalls = false;
      let assistantContent = "";
      const toolCalls: ToolCall[] = [];

      // Assemble messages with context management (budget + sliding window + summary)
      const messages = await this.contextManager.assemble(
        systemParts,
        undefined, // memory — could be wired to a memory store
        workingHistory,
        { role: "user", content: userMessage },
        context.llm  // use same LLM as compressor for summaries
      );

      // Stream LLM response
      for await (const chunk of context.llm.chat(messages, tools)) {
        if (chunk.type === "text" && chunk.content) {
          assistantContent += chunk.content;
          yield { type: "text", content: chunk.content };
        }
        if (chunk.type === "tool_call" && chunk.toolCall) {
          hasToolCalls = true;
          toolCalls.push(chunk.toolCall);
        }
        if (chunk.type === "done" && chunk.usage) {
          totalTokens +=
            chunk.usage.promptTokens + chunk.usage.completionTokens;
          inputTokens += chunk.usage.promptTokens;
          outputTokens += chunk.usage.completionTokens;
        }
      }

      // If no tool calls, agent is done
      if (!hasToolCalls) {
        yield { type: "done", iterations, totalTokens, inputTokens, outputTokens };
        return;
      }

      // Record assistant message with tool calls
      const assistantMsg: Message = {
        role: "assistant",
        content: assistantContent || "",
        toolCalls,
      };
      workingHistory.push(assistantMsg);

      // Execute all tool calls
      for (const tc of toolCalls) {
        yield {
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        };

        const dedupKey = `${tc.name}:${stableStringify(tc.arguments)}`;
        let result: ToolResult;
        const cached = successfulCalls.get(dedupKey);
        if (cached) {
          // Identical call already succeeded this run — reuse it instead of
          // re-running, and tell the model so it stops repeating.
          result = {
            content: `[skipped duplicate call: an identical ${tc.name} call already succeeded earlier in this turn — reusing that result. Do not call it again.]\n\n${cached.content}`,
            isError: false,
          };
        } else {
          result = await context.toolRegistry.execute(
            tc.name,
            tc.arguments,
            context.toolContext
          );
          if (!result.isError) successfulCalls.set(dedupKey, result);
        }

        yield {
          type: "tool_result",
          name: tc.name,
          output: result.content,
          isError: result.isError ?? false,
        };

        // Add tool result to working history
        workingHistory.push({
          role: "tool",
          content: result.content,
          toolCallId: tc.id,
        });
      }
    }

    // Max iterations reached
    yield {
      type: "error",
      message: `Reached maximum iterations (${this.config.maxIterations})`,
    };
    yield { type: "done", iterations, totalTokens, inputTokens, outputTokens };
  }
}
