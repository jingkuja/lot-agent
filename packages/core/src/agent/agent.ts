import { createHash } from "node:crypto";
import { RunBudget, RunBudgetError } from "../runtime/run-budget.js";
import type { ExecutionJournal, RuntimeObservation, RunStatus } from "../runtime/run-state.js";
import { toolEffect } from "../tools/errors.js";
import type {
  ChatParams,
  JSONSchema,
  Message,
  ContentPart,
  LLMProvider,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolErrorKind,
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
import { isMalformedToolCallError } from "../llm/retry.js";
import { formatLLMError } from "../llm/errors.js";
import { createDeadline, withAbort, abortableStream, abortableDelay } from "../runtime/abort.js";
import { estimateTokens } from "../context/tokenizer.js";

/** Events emitted during agent execution */
export type AgentEvent =
  | { type: "knowledge_sources"; sources: import("../knowledge/types.js").KnowledgeEvidence[] }
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; output: string; isError: boolean; errorKind?: ToolErrorKind }
  | {
      type: "done";
      status?: RunStatus;
      llmAttempts?: number;
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
  maxLlmAttempts: number;
  maxTotalTokens: number;
  maxNoProgressRounds: number;
  maxCost?: number;
  tokenPrices?: { input: number; output: number };
  maxToolCalls: number;
  maxParallelTools: number;
  /** Wall-clock timeout for the entire agent run in ms. Default: 1800000 (30 min) */
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
  journal?: ExecutionJournal;
  observe?: (event: RuntimeObservation) => void;
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

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 20,
  maxLlmAttempts: 60,
  maxTotalTokens: 1_000_000,
  maxNoProgressRounds: 3,
  maxToolCalls: 100,
  maxParallelTools: 4,
  maxRunTimeMs: 1_800_000, // 30 minutes
  systemPrompt: "You are a helpful AI assistant.",
};

/**
 * When a generation is rejected because the model emitted truncated/garbled
 * tool-call JSON (a sampling artifact — see `isMalformedToolCallError`), retry
 * the same generation this many times before giving up on a fresh sample. The
 * provider retries transport failures; recovery here is allowed only before
 * visible text/thinking has escaped, so retries cannot corrupt the answer.
 */
const MAX_GEN_RETRIES = 2;

/**
 * How many times a run may feed a malformed-tool-call failure back to the model
 * for recovery (retry a smaller call / ask the user how to split the work)
 * before surfacing a terminal error. Bounds a model that keeps producing
 * malformed output so it can't loop.
 */
const MAX_MALFORMED_RECOVERIES = 1;

/** Synthetic turn appended so the model recovers instead of the run dying. */
const MALFORMED_RECOVERY_NOTE =
  "[Automatic system notice] The previous tool call had incomplete or oversized arguments and was rejected by the gateway despite retries. " +
  "Do not repeat the identical call. If excessive output may have caused truncation, significantly reduce its scope before retrying. " +
  "If scope or batching requires a user decision, call ask_user.";

/** User-facing message when even the guided recovery keeps failing. */
const MALFORMED_FALLBACK_MESSAGE =
  "生成失败：模型多次返回不完整的结果（可能是内容过多被截断）。请稍后重试，或减少内容规模后再试。";

/**
 * Validate the final answer text against an outputSchema: JSON.parse then
 * full schema check (reusing the tool-input validator). Returns an error
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
    for (const key of ["maxIterations", "maxRunTimeMs", "maxToolCalls", "maxParallelTools", "maxLlmAttempts", "maxTotalTokens", "maxNoProgressRounds"] as const) {
      if (!Number.isSafeInteger(this.config[key]) || this.config[key] <= 0) throw new Error(`Invalid ${key}`);
    }
    if (this.config.maxCost !== undefined && (!Number.isFinite(this.config.maxCost) || this.config.maxCost <= 0 || !this.config.tokenPrices)) throw new Error("maxCost requires positive cost limit and tokenPrices");
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
    const deadline = createDeadline(this.config.maxRunTimeMs, opts.signal);
    const signal = deadline.signal;
    let iterations = 0;
    // How many times this run has fed a malformed-tool-call failure back to the
    // model for recovery (bounded by MAX_MALFORMED_RECOVERIES).
    let malformedRecoveries = 0;

    const budget = new RunBudget(this.config, context.observe);
    const llm = budget.wrap(context.llm);
    const compressor = this.config.contextConfig?.compressor
      ? budget.wrap(this.config.contextConfig.compressor) : llm;
    let lastObservation = "";
    let unchangedRounds = 0;
    let hasDeliverableTool = false;
    let toolCount = 0;
    let uncertainOutcome = false;
    const abortReason = () => deadline.timedOut ? "timeout" : signal.aborted ? "cancelled" : null;
    const done = (status: RunStatus = "completed"): AgentEvent => ({
      type: "done", iterations, totalTokens: budget.inputTokens + budget.outputTokens,
      inputTokens: budget.inputTokens, outputTokens: budget.outputTokens, cachedPromptTokens: budget.cachedTokens, llmAttempts: budget.attempts,
      status: uncertainOutcome ? "unknown_outcome" : deadline.timedOut ? "timed_out" : signal.aborted ? "cancelled" : status,
    });
    const abortError = (kind: "timeout" | "cancelled"): AgentEvent => ({
      type: "error", message: kind === "timeout"
        ? `Agent run timed out: ${signal.reason instanceof Error ? signal.reason.message : "deadline exceeded"}`
        : "Agent run cancelled",
    });
    try {
      signal.throwIfAborted();
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
        const userEntries = await withAbort(context.memory.listUserMemory(), signal);
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
            const docs = await withAbort(context.retriever.retrieve(context.retrievalNamespace, query), signal);
            if (docs.length > 0) {
              retrievalBlock = docs.map((d) => `- ${d.text}`).join("\n");
            }
          } catch (error) {
            if (signal.aborted) throw error;
            // swallow — retrieval is an enhancement, not a hard dependency
          }
        }
      }

      const tools = context.toolRegistry.toLLMTools(this.config.allowedToolNames);
      const allowedToolNames = tools.map(tool => tool.name);
      const toolTokens = estimateTokens(JSON.stringify(tools));
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
      const pendingCalls = new Map<string, Promise<ToolResult>>();

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
        let toolCalls: ToolCall[] = [];

        // Assemble messages with context management (budget + sliding window + summary)
        const messages = await withAbort(this.contextManager.assemble(
          systemParts,
          undefined, // memory — could be wired to a memory store
          workingHistory,
          undefined, // user message already lives in workingHistory
          compressor,
          { signal, retrieval: retrievalBlock, toolTokens, generationTokens: this.config.modelParams?.maxTokens }
        ), signal);

        // Stream LLM response — surface any failure as an event so the run
        // always terminates cleanly with a `done` (for billing/trace closure)
        // instead of throwing out of the generator. A malformed/truncated
        // tool-call rejection is a sampling artifact: retry the generation a
        // couple times (a fresh sample usually parses) before giving up.
        let streamError: unknown;
        let emittedOutput = false;
        for (let genAttempt = 0; ; genAttempt++) {
          // Reset per-attempt accumulators so a retry doesn't inherit partial
          // output from the failed attempt.
          hasToolCalls = false;
          assistantContent = "";
          toolCalls = [];
          let sawDone = false;
          try {
            for await (const chunk of abortableStream(llm.chat(messages, tools, {
              signal,
              params: this.config.modelParams,
            }), signal)) {
              if (chunk.type === "thinking" && chunk.content) {
                emittedOutput = true;
                yield { type: "thinking", content: chunk.content };
              }
              if (chunk.type === "text" && chunk.content) {
                emittedOutput = true;
                assistantContent += chunk.content;
                yield { type: "text", content: chunk.content };
              }
              if (chunk.type === "tool_call" && chunk.toolCall) {
                hasToolCalls = true;
                toolCalls.push(chunk.toolCall);
              }
              if (chunk.type === "done") {
                if (sawDone) throw new Error("Duplicate LLM completion");
                sawDone = true;
                if (chunk.finishReason && !["stop", "end_turn", "tool_calls", "tool_use", "stop_sequence"].includes(chunk.finishReason)) {
                  throw new Error(`LLM generation incomplete: ${chunk.finishReason}`);
                }
              }
            }
            if (!sawDone) throw new Error("LLM stream ended before completion");
            signal.throwIfAborted();
            streamError = undefined;
            break;
          } catch (err) {
            // Cancellation/timeout is terminal — never retry it as an artifact.
            if (abortReason()) {
              streamError = err;
              break;
            }
            if (!emittedOutput && isMalformedToolCallError(err) && genAttempt < MAX_GEN_RETRIES) {
              await abortableDelay(200 * (genAttempt + 1), signal);
              continue;
            }
            streamError = err;
            break;
          }
        }

        if (streamError !== undefined) {
          const kind = abortReason();
          if (kind) {
            yield abortError(kind);
            yield done();
            return;
          }
          // A malformed tool-call that survived silent retries: don't kill the
          // turn. Feed the failure back so the model recovers (retry a smaller
          // call, or ask_user how to split the work) — bounded so a model that
          // keeps producing malformed output can't loop forever.
          if (
            !emittedOutput && isMalformedToolCallError(streamError) &&
            malformedRecoveries < MAX_MALFORMED_RECOVERIES
          ) {
            malformedRecoveries++;
            workingHistory.push({ role: "user", content: MALFORMED_RECOVERY_NOTE });
            continue;
          }
          yield {
            type: "error",
            message: isMalformedToolCallError(streamError)
              ? MALFORMED_FALLBACK_MESSAGE
              : formatLLMError(streamError),
          };
          yield done(streamError instanceof RunBudgetError ? "budget_exhausted" : "failed");
          return;
        }

        // If no tool calls, agent is done
        if (!hasToolCalls) {
          if (!assistantContent.trim() && !hasDeliverableTool) {
            yield { type: "error", message: "Model completed without an answer or deliverable" };
            yield done("empty_response");
            return;
          }
          // Structured output: validate the final answer against the schema.
          // A violation is surfaced as an error event (not retried — the caller
          // decides what to do), then the run closes cleanly with `done`.
          if (this.config.outputSchema) {
            const err = validateStructuredOutput(assistantContent, this.config.outputSchema);
            if (err) {
              yield { type: "error", message: err };
              yield done("failed");
              return;
            }
          }
          yield done();
          return;
        }

        if (toolCount + toolCalls.length > this.config.maxToolCalls) {
          yield { type: "error", message: `Reached maximum tool calls (${this.config.maxToolCalls})` };
          yield done("budget_exhausted");
          return;
        }
        toolCount += toolCalls.length;
        const ids = new Set<string>();
        for (const tc of toolCalls) {
          if (!tc.id || ids.has(tc.id) || !tc.name) throw new Error("Invalid or duplicate tool call identity");
          ids.add(tc.id);
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
          signal.throwIfAborted();
          if (!allowedToolNames.includes(tc.name)) {
            return { content: `Tool not permitted: ${tc.name}`, isError: true, errorKind: "permission" };
          }
          const cacheable = context.toolRegistry.get(tc.name)?.cacheable ?? false;
          const dedupKey = `${tc.name}:${stableStringify(tc.arguments)}`;
          const cached = cacheable ? successfulCalls.get(dedupKey) : undefined;
          if (cached) {
            context.observe?.({ type: "cache_hit", toolName: tc.name });
            // Identical cacheable call already succeeded this run — reuse it
            // instead of re-running, and tell the model so it stops repeating.
            return {
              content: `[skipped duplicate call: an identical ${tc.name} call already succeeded earlier in this turn — reusing that result. Do not call it again.]\n\n${cached.content}`,
              isError: false,
            };
          }
          const pending = cacheable ? pendingCalls.get(dedupKey) : undefined;
          if (pending) return pending;
          const work = (async (): Promise<ToolResult> => {
            const tool = context.toolRegistry.get(tc.name)!;
            const entry = await context.journal?.start(tc, iterations, toolEffect(tool));
            if (entry?.result) return entry.result;
            const result = await context.toolRegistry.execute(
              tc.name, tc.arguments,
              { ...context.toolContext, operationId: entry?.operationId },
              { signal, allowedToolNames }
            );
            if (entry) {
              try { await context.journal!.finish(entry.operationId, result); }
              catch (error) {
                if (toolEffect(tool) !== "write") throw error;
                return { content: `Operation ${entry.operationId} may have committed but its result could not be saved. Verify before repeating.`, isError: true, errorKind: "unknown_outcome" };
              }
            }
            return result;
          })();
          if (cacheable) pendingCalls.set(dedupKey, work);
          try {
            const result = await work;
            if (cacheable && !result.isError) successfulCalls.set(dedupKey, result);
            return result;
          } finally {
            pendingCalls.delete(dedupKey);
          }
        };

        // Record a completed call's result: emit the event, append to history,
        // and report whether it ends the turn. Order-preserving.
        const observations: string[] = [];
        const recordResult = function* (
          tc: ToolCall,
          result: ToolResult
        ): Generator<AgentEvent, boolean> {
          if (!result.isError) hasDeliverableTool = true;
          observations.push(stableStringify({ name: tc.name, args: tc.arguments, error: result.errorKind,
            output: result.content.replace(/^\[skipped duplicate call:[^\n]*\]\n\n/, "") }));
          yield {
            type: "tool_result",
            toolCallId: tc.id,
            name: tc.name,
            output: result.content,
            isError: result.isError ?? false,
            ...(result.errorKind ? { errorKind: result.errorKind } : {}),
          };
          workingHistory.push({
            role: "tool",
            content: result.content,
            toolCallId: tc.id,
          });
          if (result.errorKind === "unknown_outcome") {
            uncertainOutcome = true;
            throw new Error(result.content);
          }
          signal.throwIfAborted();
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
            while (ci < toolCalls.length && parallelSafe(toolCalls[ci]) && group.length < this.config.maxParallelTools) {
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
              yield done("awaiting_input");
              return;
            }
          } else {
            const tc = toolCalls[ci];
            ci++;
            yield { type: "tool_call", id: tc.id, name: tc.name, input: tc.arguments };
            const result = await executeOne(tc);
            if (yield* recordResult(tc, result)) {
              yield done("awaiting_input");
              return;
            }
          }
        }
        const fingerprint = createHash("sha256").update(observations.join("\n")).digest("hex");
        unchangedRounds = fingerprint === lastObservation ? unchangedRounds + 1 : 1;
        lastObservation = fingerprint;
        if (unchangedRounds >= this.config.maxNoProgressRounds) {
          yield { type: "error", message: "Stopped after repeated tool calls produced no new information. Existing results are preserved; change the approach before continuing." };
          yield done("stalled");
          return;
        }
        if (unchangedRounds === this.config.maxNoProgressRounds - 1) {
          workingHistory.push({ role: "user", content: "[Runtime notice] These calls produced no new information. Replan using a different approach or answer with the results already obtained. Do not repeat identical operations." });
        }
      }

      // Max iterations reached
      yield {
        type: "error",
        message: `Reached maximum iterations (${this.config.maxIterations})`,
      };
      yield done("budget_exhausted");
    } catch (error) {
      const reason = abortReason();
      yield reason ? abortError(reason) : { type: "error", message: formatLLMError(error) };
      yield done(error instanceof RunBudgetError ? "budget_exhausted" : "failed");
    } finally {
      deadline.dispose();
    }
  }
}
