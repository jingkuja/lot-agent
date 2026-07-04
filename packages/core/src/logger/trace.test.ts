import { describe, it, expect } from "vitest";
import { TraceManager } from "./trace.js";

describe("TraceManager bounding", () => {
  it("evicts the oldest trace once maxTraces is exceeded", () => {
    const tm = new TraceManager({ maxTraces: 2 });
    const t1 = tm.startTrace("conv-1", "model-a");
    const t2 = tm.startTrace("conv-2", "model-a");
    const t3 = tm.startTrace("conv-3", "model-a");
    expect(tm.getTrace(t1.id)).toBeUndefined();
    expect(tm.getTrace(t2.id)).toBeDefined();
    expect(tm.getTrace(t3.id)).toBeDefined();
  });

  it("cascades eviction so an evicted trace's span can no longer be ended", () => {
    const tm = new TraceManager({ maxTraces: 1 });
    const t1 = tm.startTrace("conv-1", "model-a");
    const span = tm.startSpan(t1.id, "llm.chat");
    let onSpanCalls = 0;
    tm.addSink({ onTrace: () => {}, onSpan: () => { onSpanCalls++; } });
    tm.startTrace("conv-2", "model-a"); // evicts t1 and its span
    tm.endSpan(span.id); // no-op — span was cascade-deleted
    expect(onSpanCalls).toBe(0);
  });

  it("defaults maxTraces to 200 when not configured", () => {
    const tm = new TraceManager();
    for (let i = 0; i < 200; i++) tm.startTrace(`conv-${i}`, "model-a");
    const first = tm.getTraceForConversation("conv-0");
    expect(first).toBeDefined(); // not yet evicted at exactly 200
    tm.startTrace("conv-200", "model-a"); // the 201st — now evicts conv-0's trace
    expect(tm.getTraceForConversation("conv-0")).toBeUndefined();
  });
});

describe("TraceManager.getTraceForConversation", () => {
  it("returns the most recently started trace for a conversation", () => {
    const tm = new TraceManager();
    tm.startTrace("conv-1", "model-a");
    const second = tm.startTrace("conv-1", "model-a");
    expect(tm.getTraceForConversation("conv-1")?.id).toBe(second.id);
  });

  it("returns undefined for a conversation with no traces", () => {
    const tm = new TraceManager();
    expect(tm.getTraceForConversation("nope")).toBeUndefined();
  });
});
