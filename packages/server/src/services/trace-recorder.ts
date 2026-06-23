import type { TraceManager, Trace } from "@lot-agent/core";
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
  private llmSpanId: string | undefined;
  private toolSpanId: string | undefined;
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

  /** Start an LLM span (called on first text event). */
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
  startToolSpan(toolName: string): void {
    this.toolSpanId = this.traceManager.startSpan(
      this.trace.id,
      "tool.execute",
      undefined,
      { toolName }
    ).id;
  }

  /** End the current tool span (called on tool_result event). */
  endToolSpan(status: "ok" | "error"): void {
    if (this.toolSpanId) {
      this.traceManager.endSpan(this.toolSpanId, status);
      this.toolSpanId = undefined;
    }
  }

  /**
   * End any open spans, persist trace + spans to DB.
   * errorMessage: the ACTUAL error message from the `error` AgentEvent
   * (or undefined when no error occurred).
   *
   * NOTE: matches the original behavior where totalCost is set on the
   * in-memory trace metadata by the caller AFTER persistence, so the persisted
   * trace row's metadata intentionally does NOT include totalCost.
   */
  async finish(params: {
    totalTokens: number;
    errorMessage?: string;
  }): Promise<void> {
    // Close any still-open spans
    if (this.llmSpanId) this.traceManager.endSpan(this.llmSpanId);
    if (this.toolSpanId) this.traceManager.endSpan(this.toolSpanId);

    const hasError = params.errorMessage !== undefined;
    const latencyMs = Date.now() - this.requestStart;

    this.trace.metadata.totalTokens = params.totalTokens;
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
