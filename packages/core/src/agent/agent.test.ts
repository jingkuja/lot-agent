import { describe, it, expect } from "vitest";
import { Agent, type AgentContext, type AgentEvent } from "./agent.js";
import { ToolRegistry } from "../tools/registry.js";
import type {
  ChatChunk,
  LLMProvider,
  Message,
  Tool,
  ToolContext,
} from "../types/index.js";

/** LLM that replays a script of chunk-lists; one list per chat() call. Records the messages it received. */
function scriptedLLM(script: ChatChunk[][]): LLMProvider & { calls: Message[][] } {
  let i = 0;
  const calls: Message[][] = [];
  return {
    calls,
    async *chat(messages: Message[]): AsyncIterable<ChatChunk> {
      calls.push(messages);
      const chunks =
        script[i++] ?? [
          { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
        ];
      for (const c of chunks) yield c;
    },
  };
}

function toolCallChunks(id: string, name: string, args: unknown): ChatChunk[] {
  return [
    { type: "tool_call", toolCall: { id, name, arguments: args } },
    { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
  ];
}

const textChunks = (text: string): ChatChunk[] => [
  { type: "text", content: text },
  { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
];

function makeContext(llm: LLMProvider, registry = new ToolRegistry()): AgentContext {
  return {
    llm,
    toolRegistry: registry,
    toolContext: { workingDirectory: "/tmp" } as ToolContext,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("Agent.run", () => {
  it("places the user message before assistant tool calls and never duplicates it", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      description: "noop",
      parameters: {},
      async execute() {
        return { content: "ok" };
      },
    });
    const llm = scriptedLLM([
      toolCallChunks("c1", "noop", {}),
      textChunks("done"),
    ]);
    const agent = new Agent({ systemPrompt: "sys" });

    await collect(agent.run("hello", makeContext(llm, registry)));

    // Second chat call carries the accumulated history.
    const second = llm.calls[1];
    const userMessages = second.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);

    const firstUserIdx = second.findIndex((m) => m.role === "user");
    const firstAssistantIdx = second.findIndex((m) => m.role === "assistant");
    expect(firstAssistantIdx).toBeGreaterThan(-1);
    expect(firstUserIdx).toBeLessThan(firstAssistantIdx);
  });

  it("stops and reports cancellation when the external signal aborts", async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry();
    registry.register({
      name: "cancel",
      description: "aborts the run",
      parameters: {},
      async execute() {
        controller.abort();
        return { content: "aborted the run" };
      },
    });
    // Would loop forever (always a tool call) if cancellation didn't work.
    const llm = scriptedLLM([
      toolCallChunks("c1", "cancel", {}),
      toolCallChunks("c2", "cancel", {}),
      toolCallChunks("c3", "cancel", {}),
    ]);
    const agent = new Agent({ systemPrompt: "sys", maxIterations: 50 });

    const events = await collect(
      agent.run("hi", makeContext(llm, registry), [], {
        signal: controller.signal,
      })
    );

    const err = events.find((e) => e.type === "error");
    expect(err && "message" in err ? err.message : "").toContain("cancel");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("times out via maxRunTimeMs and reports a timeout", async () => {
    const slowLLM: LLMProvider = {
      async *chat(_m, _t, opts?: { signal?: AbortSignal }): AsyncIterable<ChatChunk> {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          opts?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        yield { type: "done" };
      },
    };
    const agent = new Agent({ systemPrompt: "sys", maxRunTimeMs: 30 });

    const events = await collect(agent.run("hi", makeContext(slowLLM)));

    const err = events.find((e) => e.type === "error");
    expect(err && "message" in err ? err.message : "").toContain("timed out");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("emits an error event (not a throw) when the LLM call fails", async () => {
    const failingLLM: LLMProvider = {
      // eslint-disable-next-line require-yield
      async *chat(): AsyncIterable<ChatChunk> {
        throw new Error("upstream 500");
      },
    };
    const agent = new Agent({ systemPrompt: "sys" });

    const events = await collect(agent.run("hi", makeContext(failingLLM)));

    const err = events.find((e) => e.type === "error");
    expect(err && "message" in err ? err.message : "").toContain("upstream 500");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("does NOT dedup identical calls to a non-cacheable tool", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "non-cacheable",
      parameters: {},
      async execute() {
        executions++;
        return { content: "pong" };
      },
    });
    const llm = scriptedLLM([
      toolCallChunks("c1", "ping", { x: 1 }),
      toolCallChunks("c2", "ping", { x: 1 }),
      textChunks("done"),
    ]);
    const agent = new Agent({ systemPrompt: "sys" });

    await collect(agent.run("hi", makeContext(llm, registry)));

    expect(executions).toBe(2);
  });

  it("dedups identical calls to a cacheable tool", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    const cacheableTool: Tool = {
      name: "fetch",
      description: "cacheable",
      parameters: {},
      cacheable: true,
      async execute() {
        executions++;
        return { content: "data" };
      },
    };
    registry.register(cacheableTool);
    const llm = scriptedLLM([
      toolCallChunks("c1", "fetch", { url: "a" }),
      toolCallChunks("c2", "fetch", { url: "a" }),
      textChunks("done"),
    ]);
    const agent = new Agent({ systemPrompt: "sys" });

    const events = await collect(agent.run("hi", makeContext(llm, registry)));

    expect(executions).toBe(1);
    const reuse = events.find(
      (e) => e.type === "tool_result" && /duplicate/i.test(e.output)
    );
    expect(reuse).toBeDefined();
  });
});
