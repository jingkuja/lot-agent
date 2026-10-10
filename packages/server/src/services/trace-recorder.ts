import type { TraceManager, Trace, RuntimeObservation } from "@lot-agent/core";
import type { DB } from "../db/database.js";

/**
 * Manages span lifecycle and final trace/span DB persistence for one chat turn.
 * Constructed per-request by AgentService.streamAgentResponse.
 *
 * Bug fix: finish() accepts the actual errorMessage captured from an `error`
 * AgentEvent, instead of the hardcoded "Max iterations reached" string.
 */
export class TraceRecorder {
  private trace!: Trace;
  private attemptSpans = new Map<number, string>();
  private llmSpanId: string | undefined;
  private toolSpanIds = new Map<string, string>();
  private requestStart = Date.now();

  constructor(
    private readonly traceManager: TraceManager,
    private readonly db: DB,
    private readonly llmModel: string,
    private readonly llmProvider: string
  ) {}

  /** Start a new trace for this request. Must be called before any span methods. */
  start(conversationId: string, model: string): void {
    this.trace = this.traceManager.startTrace(conversationId, model);
    this.requestStart = Date.now();
  }

  /** The live Trace object (used by AgentService to set metadata such as totalCost). */
  get traceObject(): Trace {
    return this.trace;
  }

  observe(event: RuntimeObservation): void {
    if (event.type === "llm_start") {
      this.attemptSpans.set(event.attempt, this.traceManager.startSpan(this.trace.id,
        event.purpose === "compression" ? "llm.compress" : "llm.chat", undefined,
        { attempt: event.attempt, purpose: event.purpose }).id);
    } else if (event.type === "llm_end") {
      const id = this.attemptSpans.get(event.attempt);
      if (id) this.traceManager.endSpan(id, event.failed ? "error" : "ok");
      this.attemptSpans.delete(event.attempt);
    } else {
      const span = this.traceManager.startSpan(this.trace.id, "tool.cache_hit", undefined, { toolName: event.toolName });
      this.traceManager.endSpan(span.id);
    }
  }

  /** Compatibility entrypoint for callers without attempt observations. */
  startLlmSpan(): void {
    if (!this.llmSpanId) {
      this.llmSpanId = this.traceManager.startSpan(this.trace.id, "llm.chat").id;
    }
  }

  /** End the current LLM span (called when a tool_call event arrives). */
  endLlmSpan(): void {
    if (this.llmSpanId) {
      this.traceManager.endSpan(this.llmSpanId);
      this.llmSpanId = undefined;
    }
  }

  /** Start a tool span (called on tool_call event). */
  startToolSpan(toolName: string, toolCallId = toolName): void {
    const span = this.traceManager.startSpan(
      this.trace.id,
      "tool.execute",
      undefined,
      { toolName, toolCallId }
    );
    this.toolSpanIds.set(toolCallId, span.id);
  }

  /** End the current tool span (called on tool_result event). */
  endToolSpan(status: "ok" | "error", toolCallId?: string): void {
    const key = toolCallId ?? (this.toolSpanIds.size === 1 ? this.toolSpanIds.keys().next().value : undefined);
    const spanId = key ? this.toolSpanIds.get(key) : undefined;
    if (key && spanId) {
      this.traceManager.endSpan(spanId, status);
      this.toolSpanIds.delete(key);
    }
  }

  /**
   * End any open spans, persist trace + spans to DB.
   * errorMessage: the ACTUAL error message from the `error` AgentEvent
   * (or undefined when no error occurred).
   *
   */
  async finish(params: {
    totalTokens: number;
    cachedPromptTokens?: number;
    errorMessage?: string;
  }): Promise<void> {
    for (const id of this.attemptSpans.values()) this.traceManager.endSpan(id, "error");
    this.attemptSpans.clear();
    // Close any still-open spans
    if (this.llmSpanId) this.traceManager.endSpan(this.llmSpanId);
    for (const id of this.toolSpanIds.values()) this.traceManager.endSpan(id, "error");
    this.toolSpanIds.clear();

    const hasError = params.errorMessage !== undefined;
    const latencyMs = Date.now() - this.requestStart;

    this.trace.metadata.totalTokens = params.totalTokens;
    if (params.cachedPromptTokens !== undefined) {
      (this.trace.metadata as Record<string, unknown>).cachedPromptTokens =
        params.cachedPromptTokens;
    }
    if (hasError) {
      (this.trace.metadata as Record<string, unknown>).status = "error";
    }
    this.traceManager.endTrace(this.trace.id);

    await this.db.addTrace({
      id: this.trace.id,
      conversation_id: this.trace.conversationId,
      model: this.llmModel,
      provider: this.llmProvider,
      total_tokens: params.totalTokens,
      total_latency_ms: latencyMs,
      status: hasError ? "error" : "ok",
      error_message: params.errorMessage, // FIXED: actual message, not hardcoded
      metadata: this.trace.metadata as Record<string, unknown>,
    });

    for (const span of this.trace.spans) {
      await this.db.addSpan({
        id: span.id,
        trace_id: this.trace.id,
        parent_span_id: span.parentSpanId,
        name: span.name,
        status: span.status,
        attributes: span.attributes,
        events: span.events,
        start_time: new Date(span.startTime).toISOString(),
        end_time: span.endTime ? new Date(span.endTime).toISOString() : undefined,
      });
    }
  }
}
