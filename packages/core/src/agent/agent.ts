import type {
  ChatParams,
  JSONSchema,
  Message,
  ContentPart,
  LLMProvider,
  ToolCall,
  ToolContext,
  ToolResult,
} from "../types/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { validateToolInput } from "../tools/validate.js";
import {
  ContextManager,
  type ContextManagerConfig,
  type SummaryState,
} from "../context/index.js";
import type { AgentMemoryStore } from "../memory/index.js";
import { formatEntriesForPrompt } from "../memory/index.js";
import type { Retriever } from "../retrieval/index.js";
import { hasMemoryTools, MEMORY_POLICY_PROMPT } from "../memory/policy.js";
import { hasAskUserTool, ASK_USER_POLICY_PROMPT } from "../tools/ask-user.js";

/** Events emitted during agent execution */
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | {
      type: "done";
      iterations: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      cachedPromptTokens: number;
    }
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
  modelParams?: ChatParams;
  /**
   * JSON Schema the final answer must satisfy. When set, it is pushed to the
   * provider as `ChatParams.responseSchema` (constrained generation) AND the
   * final text is JSON-parsed + shallow-validated at the end of the run; a
   * violation surfaces as a structured `error` event (the run is not retried).
   */
  outputSchema?: JSONSchema;
}

export interface AgentContext {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  memory?: AgentMemoryStore;
  /**
   * Optional retrieval facade (E4). When set together with
   * `retrievalNamespace`, the run retrieves documents for the user's message
   * once and injects them as a `[Retrieved Context]` block. Absent → zero
   * overhead, fully backward compatible.
   */
  retriever?: Retriever;
  /** Namespace to retrieve from (e.g. `user:{id}:notes`). */
  retrievalNamespace?: string;
}

export interface AgentRunOptions {
  /**
   * Caller-supplied signal (e.g. the SSE request's signal). When it aborts —
   * typically because the client disconnected — the run stops promptly instead
   * of continuing to spend tokens on output nobody is reading.
   */
  signal?: AbortSignal;
}

/** Combine signals into one that aborts when any input aborts. */
function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 20,
  maxRunTimeMs: 600_000, // 5 minutes
  systemPrompt: "You are a helpful AI assistant.",
};

/**
 * Validate the final answer text against an outputSchema: JSON.parse then
 * shallow schema check (reusing the tool-input validator). Returns an error
 * message, or null when valid.
 */
function validateStructuredOutput(text: string, schema: JSONSchema): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `Structured output is not valid JSON: ${text.slice(0, 200)}`;
  }
  const errors = validateToolInput(schema, parsed);
  return errors.length ? `Structured output failed schema validation: ${errors.join("; ")}` : null;
}

/** Flatten a user message to its text for use as a retrieval query. */
function messageQueryText(message: string | ContentPart[]): string {
  if (typeof message === "string") return message;
  return message
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

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
    // Push outputSchema down to the provider as a constrained-generation hint,
    // unless the caller already set an explicit responseSchema.
    if (this.config.outputSchema) {
      this.config.modelParams = {
        ...this.config.modelParams,
        responseSchema: this.config.modelParams?.responseSchema ?? this.config.outputSchema,
      };
    }
    this.contextManager = new ContextManager(this.config.contextConfig);
  }

  /** Rolling-summary state after a run, for the caller to persist. */
  getContextSummaryState(): SummaryState | undefined {
    return this.contextManager.getSummaryState();
  }

  async *run(
    userMessage: string | ContentPart[],
    context: AgentContext,
    history: Message[] = [],
    opts: AgentRunOptions = {}
  ): AsyncIterable<AgentEvent> {
    // Clear ephemeral memory at the start of each run
    context.memory?.clearEphemeral();

    // Build system prompt parts
    const systemParts = [this.config.systemPrompt];
    if (this.config.dynamicPromptParts?.length) {
      systemParts.push(...this.config.dynamicPromptParts);
    }

    // Inject memory usage policy when this agent can use memory tools
    if (context.memory && hasMemoryTools(this.config.allowedToolNames)) {
      systemParts.push(MEMORY_POLICY_PROMPT);
    }

    // Inject the ask-user policy when this agent can use the ask_user tool
    if (
      context.toolRegistry.get("ask_user") &&
      hasAskUserTool(this.config.allowedToolNames)
    ) {
      systemParts.push(ASK_USER_POLICY_PROMPT);
    }

    // Inject memory into system prompt
    if (context.memory) {
      const memoryPrompt = context.memory.formatForPrompt();
      if (memoryPrompt) {
        systemParts.push(memoryPrompt);
      }

      // Also load user memory (async) — bounded like the other memory blocks.
      const userEntries = await context.memory.listUserMemory();
      const userMem = formatEntriesForPrompt(userEntries);
      if (userMem) {
        systemParts.push(`[User Memory]\n${userMem}`);
      }
    }

    // Retrieval (E4): fetch context for the user's message once — the query is
    // the constant user message, so re-retrieving each ReAct iteration would
    // only repeat work. Formatted into a stable `[Retrieved Context]` block and
    // fed to every assemble() (bounded by budget.retrieval). Best-effort: a
    // retriever failure must not abort the run.
    let retrievalBlock: string | undefined;
    if (context.retriever && context.retrievalNamespace) {
      const query = messageQueryText(userMessage);
      if (query) {
        try {
          const docs = await context.retriever.retrieve(context.retrievalNamespace, query);
          if (docs.length > 0) {
            retrievalBlock = docs.map((d) => `- ${d.text}`).join("\n");
          }
        } catch {
          // swallow — retrieval is an enhancement, not a hard dependency
        }
      }
    }

    const tools = context.toolRegistry.toLLMTools(this.config.allowedToolNames);
    let iterations = 0;
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedPromptTokens = 0;

    // Working message log (accumulates during this run). The user message is
    // part of the conversation exactly once, in turn order — re-appending it
    // each iteration would push it *after* the assistant's tool calls/results,
    // confusing the model into re-doing work.
    const workingHistory: Message[] = [
      ...history,
      { role: "user", content: userMessage },
    ];

    // Dedup successful tool calls within this run, but ONLY for tools marked
    // `cacheable` (pure/idempotent reads). A model that re-issues an identical
    // cacheable call reuses the prior result instead of re-executing — avoids
    // wasteful repeats (e.g. the same web fetch). Failed calls are NOT cached,
    // so the model can still retry after a transient failure.
    const successfulCalls = new Map<string, ToolResult>();

    // Hard, cancellable deadline: abort in-flight LLM/tool work at the timeout,
    // and honor a caller-supplied signal (e.g. SSE client disconnect) so we
    // stop the moment nobody is listening — not just between iterations.
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(),
      this.config.maxRunTimeMs
    );
    (timer as { unref?: () => void }).unref?.();
    const signal = anySignal(opts.signal, timeoutController.signal);

    const abortReason = (): "timeout" | "cancelled" | null => {
      if (timeoutController.signal.aborted) return "timeout";
      if (opts.signal?.aborted) return "cancelled";
      return null;
    };
    const done = (): AgentEvent => ({
      type: "done",
      iterations,
      totalTokens,
      inputTokens,
      outputTokens,
      cachedPromptTokens,
    });
    const abortError = (kind: "timeout" | "cancelled"): AgentEvent =>
      kind === "timeout"
        ? {
            type: "error",
            message: `Agent run timed out after ${Math.round(this.config.maxRunTimeMs / 1000)}s`,
          }
        : { type: "error", message: "Agent run cancelled" };

    try {
      while (iterations < this.config.maxIterations) {
        const aborted = abortReason();
        if (aborted) {
          yield abortError(aborted);
          yield done();
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
          undefined, // user message already lives in workingHistory
          context.llm, // use same LLM as compressor for summaries
          { signal, retrieval: retrievalBlock } // honor timeout + inject retrieved context
        );

        // Stream LLM response — surface any failure as an event so the run
        // always terminates cleanly with a `done` (for billing/trace closure)
        // instead of throwing out of the generator.
        try {
          for await (const chunk of context.llm.chat(messages, tools, {
            signal,
            params: this.config.modelParams,
          })) {
            if (chunk.type === "thinking" && chunk.content) {
              yield { type: "thinking", content: chunk.content };
            }
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
              cachedPromptTokens += chunk.usage.cachedPromptTokens ?? 0;
            }
          }
        } catch (err) {
          const kind = abortReason();
          yield kind
            ? abortError(kind)
            : {
                type: "error",
                message: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
              };
          yield done();
          return;
        }

        // If no tool calls, agent is done
        if (!hasToolCalls) {
          // Structured output: validate the final answer against the schema.
          // A violation is surfaced as an error event (not retried — the caller
          // decides what to do), then the run closes cleanly with `done`.
          if (this.config.outputSchema) {
            const err = validateStructuredOutput(assistantContent, this.config.outputSchema);
            if (err) yield { type: "error", message: err };
          }
          yield done();
          return;
        }

        // Record assistant message with tool calls
        const assistantMsg: Message = {
          role: "assistant",
          content: assistantContent || "",
          toolCalls,
        };
        workingHistory.push(assistantMsg);

        // Execute a single tool call, honoring the cacheable dedup cache.
        const executeOne = async (tc: ToolCall): Promise<ToolResult> => {
          const cacheable = context.toolRegistry.get(tc.name)?.cacheable ?? false;
          const dedupKey = `${tc.name}:${stableStringify(tc.arguments)}`;
          const cached = cacheable ? successfulCalls.get(dedupKey) : undefined;
          if (cached) {
            // Identical cacheable call already succeeded this run — reuse it
            // instead of re-running, and tell the model so it stops repeating.
            return {
              content: `[skipped duplicate call: an identical ${tc.name} call already succeeded earlier in this turn — reusing that result. Do not call it again.]\n\n${cached.content}`,
              isError: false,
            };
          }
          const result = await context.toolRegistry.execute(
            tc.name,
            tc.arguments,
            context.toolContext,
            { signal }
          );
          if (cacheable && !result.isError) successfulCalls.set(dedupKey, result);
          return result;
        };

        // Record a completed call's result: emit the event, append to history,
        // and report whether it ends the turn. Order-preserving.
        const recordResult = function* (
          tc: ToolCall,
          result: ToolResult
        ): Generator<AgentEvent, boolean> {
          yield {
            type: "tool_result",
            name: tc.name,
            output: result.content,
            isError: result.isError ?? false,
          };
          workingHistory.push({
            role: "tool",
            content: result.content,
            toolCallId: tc.id,
          });
          // An endsTurn tool that succeeded hands control back to the user
          // (e.g. ask_user). Remaining batched calls are skipped; the model
          // re-plans after the user's reply next turn.
          return !result.isError && (context.toolRegistry.get(tc.name)?.endsTurn ?? false);
        };

        // Execute tool calls, batching consecutive parallel-safe (read-only)
        // calls with Promise.all. Events still yield in call order.
        let ci = 0;
        while (ci < toolCalls.length) {
          const parallelSafe = (tc: ToolCall) =>
            context.toolRegistry.get(tc.name)?.parallelSafe ?? false;

          if (parallelSafe(toolCalls[ci])) {
            // Gather the run of consecutive parallel-safe calls.
            const group: ToolCall[] = [];
            while (ci < toolCalls.length && parallelSafe(toolCalls[ci])) {
              group.push(toolCalls[ci]);
              ci++;
            }
            for (const tc of group) {
              yield { type: "tool_call", id: tc.id, name: tc.name, input: tc.arguments };
            }
            const results = await Promise.all(group.map(executeOne));
            let ended = false;
            for (let k = 0; k < group.length; k++) {
              if (yield* recordResult(group[k], results[k])) ended = true;
            }
            if (ended) {
              yield done();
              return;
            }
          } else {
            const tc = toolCalls[ci];
            ci++;
            yield { type: "tool_call", id: tc.id, name: tc.name, input: tc.arguments };
            const result = await executeOne(tc);
            if (yield* recordResult(tc, result)) {
              yield done();
              return;
            }
          }
        }
      }

      // Max iterations reached
      yield {
        type: "error",
        message: `Reached maximum iterations (${this.config.maxIterations})`,
      };
      yield done();
    } finally {
      clearTimeout(timer);
    }
  }
}
