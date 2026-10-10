import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentEvent } from "./agent.js";
import { ToolRegistry } from "../tools/registry.js";
import { createDeadline } from "../runtime/abort.js";
import { withLLMRetry } from "../llm/retry.js";
import type { LLMProvider, ToolResult } from "../types/index.js";

const done = { type: "done" as const, usage: { promptTokens: 10, completionTokens: 5 } };
async function drain(events: AsyncIterable<AgentEvent>) { const result = []; for await (const e of events) result.push(e); return result; }
function ctx(llm: LLMProvider, toolRegistry = new ToolRegistry()) { return { llm, toolRegistry, toolContext: { workingDirectory: "/tmp" } }; }

describe("run execution state", () => {
  it("preserves a parent timeout instead of reporting user cancellation", async () => {
    const parent = createDeadline(10);
    try {
      const events = await drain(new Agent().run("hello", ctx({ async *chat() { await new Promise(() => {}); } }), [], { signal: parent.signal }));
      expect(events.at(-1)).toMatchObject({ status: "timed_out" });
    } finally { parent.dispose(); }
  });

  it("rejects an empty successful provider response", async () => {
    const events = await drain(new Agent().run("hello", ctx({ async *chat() { yield done; } })));
    expect(events.at(-1)).toMatchObject({ status: "empty_response" });
  });

  it("ends repeated observations before exhausting twenty model calls", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ content: "same evidence" }));
    registry.register({ name: "lookup", description: "", parameters: {}, effect: "read", cacheable: true, execute });
    const chat = vi.fn(async function* () {
      yield { type: "tool_call" as const, toolCall: { id: "a", name: "lookup", arguments: {} } }; yield done;
    });
    const events = await drain(new Agent().run("research", ctx({ chat }, registry)));
    expect(events.at(-1)).toMatchObject({ status: "stalled" });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("counts provider retries in the same run budget and traces tool-only generations", async () => {
    const request = vi.fn(async function* () { throw new Error("429"); yield done; });
    const llm: LLMProvider = { reportsAttempts: true, async *chat(_m, _t, opts) {
      yield* withLLMRetry(request, { maxRetries: 5, baseDelayMs: 0, onAttempt: opts?.onAttempt, onAttemptEnd: opts?.onAttemptEnd });
    } };
    const observe = vi.fn();
    const events = await drain(new Agent({ maxLlmAttempts: 2 }).run("hi", { ...ctx(llm), observe }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ status: "budget_exhausted", llmAttempts: 2 });
    expect(observe.mock.calls.filter(([e]) => e.type === "llm_start")).toHaveLength(2);
  });

  it("requires durable intent before executing and records result before yielding it", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: "write", description: "", parameters: {}, execute: async (_i, context) => {
      expect(context.operationId).toBe("operation-1"); order.push("execute"); return { content: "created" };
    } });
    const journal = { start: vi.fn(async () => { order.push("intent"); return { operationId: "operation-1" }; }),
      finish: vi.fn(async () => { order.push("result"); }) };
    const llm: LLMProvider = { async *chat() { yield { type: "tool_call", toolCall: { id: "a", name: "write", arguments: {} } }; yield done; } };
    for await (const event of new Agent({ maxIterations: 1 }).run("create", { ...ctx(llm, registry), journal })) {
      if (event.type === "tool_result") order.push("event");
    }
    expect(order).toEqual(["intent", "execute", "result", "event"]);
    journal.start.mockRejectedValueOnce(new Error("DB unavailable"));
    order.length = 0;
    await drain(new Agent().run("create", { ...ctx(llm, registry), journal }));
    expect(order).not.toContain("execute");
  });

  it("does not replay an unresolved operation from an earlier request", async () => {
    const execute = vi.fn(async () => ({ content: "written" }));
    const registry = new ToolRegistry();
    registry.register({ name: "write", description: "", parameters: {}, execute });
    const result: ToolResult = { content: "verify operation-1", isError: true, errorKind: "unknown_outcome" };
    const llm: LLMProvider = { async *chat() { yield { type: "tool_call", toolCall: { id: "a", name: "write", arguments: {} } }; yield done; } };
    const events = await drain(new Agent().run("retry", { ...ctx(llm, registry), journal: {
      start: async () => ({ operationId: "operation-1", result }), finish: vi.fn(),
    } }));
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ status: "unknown_outcome" });
  });
});
