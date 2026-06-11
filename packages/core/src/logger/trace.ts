import { randomUUID } from "node:crypto";

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, unknown>;
}

export interface Span {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export interface Trace {
  id: string;
  conversationId: string;
  startTime: number;
  endTime?: number;
  spans: Span[];
  metadata: {
    model: string;
    totalTokens: number;
    duration?: number;
  };
}

export interface TraceSink {
  onTrace(trace: Trace): void;
  onSpan(span: Span): void;
}

/** Console pretty-print sink */
export class ConsoleSink implements TraceSink {
  onTrace(trace: Trace): void {
    const duration = trace.endTime
      ? `${trace.endTime - trace.startTime}ms`
      : "running";
    console.log(
      `[Trace] ${trace.id} conversation=${trace.conversationId} ${duration}`
    );
  }

  onSpan(span: Span): void {
    const duration = span.endTime
      ? `${span.endTime - span.startTime}ms`
      : "running";
    const indent = span.parentSpanId ? "  " : "";
    console.log(
      `${indent}[Span] ${span.name} ${span.status} ${duration}`,
      Object.keys(span.attributes).length ? span.attributes : ""
    );
  }
}

export class TraceManager {
  private traces = new Map<string, Trace>();
  private spans = new Map<string, Span>();
  private sinks: TraceSink[] = [];

  addSink(sink: TraceSink): void {
    this.sinks.push(sink);
  }

  startTrace(conversationId: string, model: string): Trace {
    const trace: Trace = {
      id: randomUUID(),
      conversationId,
      startTime: Date.now(),
      spans: [],
      metadata: { model, totalTokens: 0 },
    };
    this.traces.set(trace.id, trace);
    return trace;
  }

  endTrace(traceId: string): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.endTime = Date.now();
    trace.metadata.duration = trace.endTime - trace.startTime;
    for (const sink of this.sinks) sink.onTrace(trace);
  }

  startSpan(
    traceId: string,
    name: string,
    parentSpanId?: string,
    attributes: Record<string, unknown> = {}
  ): Span {
    const span: Span = {
      id: randomUUID(),
      traceId,
      parentSpanId,
      name,
      startTime: Date.now(),
      status: "ok",
      attributes,
      events: [],
    };
    this.spans.set(span.id, span);

    const trace = this.traces.get(traceId);
    if (trace) trace.spans.push(span);

    return span;
  }

  endSpan(spanId: string, status: "ok" | "error" = "ok"): void {
    const span = this.spans.get(spanId);
    if (!span) return;
    span.endTime = Date.now();
    span.status = status;
    for (const sink of this.sinks) sink.onSpan(span);
  }

  addSpanEvent(
    spanId: string,
    name: string,
    attributes: Record<string, unknown> = {}
  ): void {
    const span = this.spans.get(spanId);
    if (!span) return;
    span.events.push({ name, timestamp: Date.now(), attributes });
  }

  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  getTraceForConversation(conversationId: string): Trace | undefined {
    for (const trace of this.traces.values()) {
      if (trace.conversationId === conversationId) return trace;
    }
    return undefined;
  }
}
