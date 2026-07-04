import { describe, it, expect } from "vitest";
import { TraceManager } from "@lot-agent/core";
import { TraceRecorder } from "./trace-recorder.js";

function fakeDb() {
  const traces: any[] = [];
  return {
    traces,
    addTrace: async (t: any) => {
      traces.push(t);
    },
    addSpan: async () => {},
  } as any;
}

describe("TraceRecorder.finish", () => {
  it("writes cachedPromptTokens into the persisted trace metadata when provided", async () => {
    const db = fakeDb();
    const tm = new TraceManager();
    const recorder = new TraceRecorder(tm, db, "claude-x", "anthropic");
    recorder.start("conv-1", "claude-x");
    await recorder.finish({ totalTokens: 100, cachedPromptTokens: 40 });
    expect(db.traces[0].metadata.cachedPromptTokens).toBe(40);
  });

  it("omits cachedPromptTokens from metadata when not provided", async () => {
    const db = fakeDb();
    const tm = new TraceManager();
    const recorder = new TraceRecorder(tm, db, "claude-x", "anthropic");
    recorder.start("conv-1", "claude-x");
    await recorder.finish({ totalTokens: 100 });
    expect(db.traces[0].metadata.cachedPromptTokens).toBeUndefined();
  });
});
