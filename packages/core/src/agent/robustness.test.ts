import { describe, it, expect, vi } from "vitest";
import { Agent, type AgentEvent } from "./agent.js";
import { ToolRegistry } from "../tools/registry.js";
import { ContextManager } from "../context/context-manager.js";
import type { ChatChunk, LLMProvider } from "../types/index.js";

const done: ChatChunk = { type: "done", usage: { promptTokens: 1, completionTokens: 1 } };
async function collect(run: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}
function context(llm: LLMProvider, toolRegistry = new ToolRegistry()) {
  return { llm, toolRegistry, toolContext: { workingDirectory: "/tmp" } };
}

describe("ReAct execution invariants", () => {
  it("never executes a tool outside this run's whitelist", async () => {
    const execute = vi.fn(async () => ({ content: "secret" }));
    const registry = new ToolRegistry();
    registry.register({ name: "hidden", description: "", parameters: {}, execute });
    const llm: LLMProvider = { async *chat() {
      yield { type: "tool_call", toolCall: { id: "1", name: "hidden", arguments: {} } };
      yield done;
    } };
    const events = await collect(new Agent({ allowedToolNames: [], maxIterations: 1 }).run("hi", context(llm, registry)));
    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", isError: true }));
  });

  it("includes memory preparation in the run deadline even if memory ignores cancellation", async () => {
    const chat = vi.fn(async function* () { yield done; });
    const ctx = { ...context({ chat }), memory: {
      clearEphemeral() {}, formatForPrompt() { return ""; },
      listUserMemory: () => new Promise(() => {}),
    } as any };
    const events = await collect(new Agent({ maxRunTimeMs: 10 }).run("hi", ctx));
    expect(chat).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("timed out") }));
    expect(events.filter(e => e.type === "done")).toHaveLength(1);
  });

  it("finalizes cancellation during compression without throwing", async () => {
    const controller = new AbortController();
    const llm: LLMProvider = { async *chat() {
      controller.abort(); throw new Error("compression aborted");
    } };
    const events = await collect(new Agent({ contextConfig: { budget: { total: 200 }, maxRawRounds: 1 } })
      .run("new user", context(llm), [
        { role: "user", content: "x".repeat(12000) },
        { role: "assistant", content: "y".repeat(12000) },
      ], { signal: controller.signal }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("cancel") }));
    expect(events.filter(e => e.type === "done")).toHaveLength(1);
  });

  it("honors a configured compressor", async () => {
    const compress = vi.fn(async function* () { yield { type: "text" as const, content: "tiny" }; yield done; });
    const chat = vi.fn(async function* () { yield done; });
    await collect(new Agent({ contextConfig: { compressor: { chat: compress }, budget: { total: 5000 }, maxRawRounds: 1 } })
      .run("new user", context({ chat }), [
        { role: "user", content: "x".repeat(40000) },
        { role: "assistant", content: "y".repeat(40000) },
      ]));
    expect(compress).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("deduplicates identical cacheable calls within a parallel batch", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const registry = new ToolRegistry();
    registry.register({ name: "read", description: "", parameters: {}, cacheable: true, parallelSafe: true, execute });
    const llm: LLMProvider = { async *chat() {
      for (const id of ["a", "b"]) yield { type: "tool_call", toolCall: { id, name: "read", arguments: {} } };
      yield done;
    } };
    await collect(new Agent({ maxIterations: 1 }).run("hi", context(llm, registry)));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not accept EOF or truncated generation as success or execute buffered tools", async () => {
    for (const finish of [undefined, "length", "content_filter"]) {
      const execute = vi.fn(async () => ({ content: "ok" }));
      const registry = new ToolRegistry();
      registry.register({ name: "write", description: "", parameters: {}, execute });
      const llm: LLMProvider = { async *chat() {
        yield { type: "tool_call", toolCall: { id: "a", name: "write", arguments: {} } };
        if (finish) yield { ...done, finishReason: finish };
      } };
      const events = await collect(new Agent().run("hi", context(llm, registry)));
      expect(execute).not.toHaveBeenCalled();
      expect(events.some(e => e.type === "error")).toBe(true);
      expect(events.filter(e => e.type === "done")).toHaveLength(1);
    }
  });

  it("rejects an unshrinkable context before sending an oversized request", async () => {
    const manager = new ContextManager({ budget: { total: 4096, generation: 1000 } });
    await expect(manager.assemble(["sys"], undefined, [
      { role: "user", content: "create presentation" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "generate_ppt", arguments: { content: "文".repeat(9000) } }] },
      { role: "tool", toolCallId: "a", content: "created" },
    ])).rejects.toThrow(/context|budget/i);
  });
});

it("stops the run after an uncertain write instead of letting the model repeat it", async () => {
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => ({ content: "possibly committed", isError: true, errorKind: "unknown_outcome" as const }));
  registry.register({ name: "write", description: "", parameters: {}, execute });
  const chat = vi.fn(async function* () {
    yield { type: "tool_call" as const, toolCall: { id: "a", name: "write", arguments: {} } };
    yield done;
  });
  const events = await collect(new Agent().run("hi", context({ chat }, registry)));
  expect(chat).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ type: "done", status: "unknown_outcome" });
});

it("enforces both a tool-call budget and a parallel concurrency cap", async () => {
  let active = 0;
  let peak = 0;
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return { content: "ok" };
  });
  registry.register({ name: "read", description: "", parameters: {}, parallelSafe: true, retrySafe: true, execute });
  const llm: LLMProvider = { async *chat() {
    for (let i = 0; i < 7; i++) yield { type: "tool_call", toolCall: { id: String(i), name: "read", arguments: { i } } };
    yield done;
  } };
  await collect(new Agent({ maxIterations: 1, maxParallelTools: 2 }).run("hi", context(llm, registry)));
  expect(execute).toHaveBeenCalledTimes(7);
  expect(peak).toBe(2);
  execute.mockClear();
  const events = await collect(new Agent({ maxToolCalls: 3 }).run("hi", context(llm, registry)));
  expect(execute).not.toHaveBeenCalled();
  expect(events.at(-1)).toMatchObject({ status: "budget_exhausted" });
});
