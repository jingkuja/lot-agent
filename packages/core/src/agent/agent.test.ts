import { describe, it, expect } from "vitest";
import { Agent, type AgentContext, type AgentEvent } from "./agent.js";
import { ToolRegistry } from "../tools/registry.js";
import type {
  ChatChunk,
  ChatOptions,
  LLMProvider,
  LLMTool,
  Message,
  Tool,
  ToolContext,
} from "../types/index.js";

/** LLM that replays a script of chunk-lists; one list per chat() call. Records the messages and opts it received. */
function scriptedLLM(
  script: ChatChunk[][]
): LLMProvider & { calls: Message[][]; optsCalls: (ChatOptions | undefined)[] } {
  let i = 0;
  const calls: Message[][] = [];
  const optsCalls: (ChatOptions | undefined)[] = [];
  return {
    calls,
    optsCalls,
    async *chat(
      messages: Message[],
      _tools?: LLMTool[],
      opts?: ChatOptions
    ): AsyncIterable<ChatChunk> {
      calls.push(messages);
      optsCalls.push(opts);
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

});

/** LLM where each call optionally yields chunks then optionally throws. Lets a
 * test emit a preamble before failing, reproducing the mid-stream malformed
 * tool-call rejection. */
function stepLLM(
  steps: Array<{ chunks?: ChatChunk[]; error?: Error }>
): LLMProvider & { calls: Message[][] } {
  let i = 0;
  const calls: Message[][] = [];
  return {
    calls,
    async *chat(messages: Message[]): AsyncIterable<ChatChunk> {
      calls.push(messages);
      const step = steps[i++] ?? {
        chunks: [{ type: "done", usage: { promptTokens: 1, completionTokens: 1 } }],
      };
      for (const c of step.chunks ?? []) yield c;
      if (step.error) throw step.error;
    },
  };
}

const MALFORMED = () =>
  new Error(
    "The model returned incomplete tool_call arguments. Function 'generate_ppt' has malformed arguments. Please retry the request."
  );

describe("Agent.run malformed tool-call recovery", () => {
  it("silently retries a malformed tool-call error even after a preamble streamed", async () => {
    const llm = stepLLM([
      // preamble text THEN the vendor rejects the truncated tool call
      { chunks: [{ type: "text", content: "好的，我来生成" }], error: MALFORMED() },
      { chunks: textChunks("done") },
    ]);
    const agent = new Agent({ systemPrompt: "sys" });

    const events = await collect(agent.run("hi", makeContext(llm)));

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(llm.calls.length).toBe(2); // retried the generation
  });

  it("feeds the failure back to the model after silent retries are exhausted", async () => {
    const llm = stepLLM([
      { error: MALFORMED() },
      { error: MALFORMED() },
      { error: MALFORMED() }, // initial + 2 silent retries all fail
      { chunks: textChunks("recovered with fewer slides") },
    ]);
    const agent = new Agent({ systemPrompt: "sys" });

    const events = await collect(agent.run("hi", makeContext(llm)));

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(llm.calls.length).toBe(4);
    // The 4th call carries a synthetic recovery note guiding the model.
    const fourth = llm.calls[3];
    expect(
      fourth.some(
        (m) => m.role === "user" && String(m.content).includes("[系统自动提示]")
      )
    ).toBe(true);
  });

  it("surfaces a friendly (non-raw) error when recovery also keeps failing, without looping forever", async () => {
    const llm = stepLLM(Array.from({ length: 20 }, () => ({ error: MALFORMED() })));
    const agent = new Agent({ systemPrompt: "sys" });

    const events = await collect(agent.run("hi", makeContext(llm)));

    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    // Not the raw vendor string dumped at the user.
    expect(err && "message" in err ? err.message : "").not.toContain(
      "incomplete tool_call"
    );
    expect(llm.calls.length).toBeLessThan(10); // bounded
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("does not retry a non-malformed error — surfaces it immediately", async () => {
    const llm = stepLLM([{ error: new Error("400 bad request: invalid model") }]);
    const agent = new Agent({ systemPrompt: "sys" });

    const events = await collect(agent.run("hi", makeContext(llm)));

    const err = events.find((e) => e.type === "error");
    expect(err && "message" in err ? err.message : "").toContain("invalid model");
    expect(llm.calls.length).toBe(1);
  });
});

describe("Agent.run (cont)", () => {
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

  it("ends the run after a successful endsTurn tool without re-calling the LLM", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "ask_user",
      description: "ask",
      parameters: { type: "object", properties: {} },
      endsTurn: true,
      execute: async () => ({ content: "[waiting]" }),
    });
    const llm = scriptedLLM([
      toolCallChunks("t1", "ask_user", { question: "几页？" }),
      textChunks("SHOULD NOT HAPPEN"),
    ]);
    const events = await collect(
      new Agent().run("做个PPT", makeContext(llm, registry))
    );
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "done"]);
    expect(llm.calls.length).toBe(1); // 没有第二次 LLM 调用
  });

  it("skips remaining batched tool calls after an endsTurn tool", async () => {
    const registry = new ToolRegistry();
    let otherRan = false;
    registry.register({
      name: "ask_user",
      description: "ask",
      parameters: { type: "object", properties: {} },
      endsTurn: true,
      execute: async () => ({ content: "[waiting]" }),
    });
    registry.register({
      name: "other",
      description: "other",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        otherRan = true;
        return { content: "ran" };
      },
    });
    const llm = scriptedLLM([
      [
        { type: "tool_call", toolCall: { id: "t1", name: "ask_user", arguments: {} } },
        { type: "tool_call", toolCall: { id: "t2", name: "other", arguments: {} } },
        { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
      ],
    ]);
    await collect(new Agent().run("hi", makeContext(llm, registry)));
    expect(otherRan).toBe(false);
  });

  it("does NOT end the turn when the endsTurn tool errors", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "ask_user",
      description: "ask",
      parameters: { type: "object", properties: {} },
      endsTurn: true,
      execute: async () => ({ content: "missing question", isError: true, errorKind: "validation" }),
    });
    const llm = scriptedLLM([
      toolCallChunks("t1", "ask_user", {}),
      textChunks("recovered"),
    ]);
    const events = await collect(new Agent().run("hi", makeContext(llm, registry)));
    // 错误结果不结束回合——模型拿到错误后第二轮继续输出文本
    expect(llm.calls.length).toBe(2);
    expect(events.some((e) => e.type === "text" && e.content === "recovered")).toBe(true);
  });
});

describe("Agent.run — E1 additions", () => {
  it("forwards thinking chunks as AgentEvents without adding them to workingHistory", async () => {
    const llm = scriptedLLM([
      [
        { type: "thinking", content: "let me think..." },
        { type: "text", content: "answer" },
        { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
      ],
    ]);
    const agent = new Agent({ systemPrompt: "sys" });
    const events = await collect(agent.run("hi", makeContext(llm)));
    expect(events).toContainEqual({ type: "thinking", content: "let me think..." });
  });

  it("accumulates cachedPromptTokens from usage into the done event", async () => {
    const llm = scriptedLLM([
      [
        { type: "text", content: "hi" },
        {
          type: "done",
          usage: { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 4 },
        },
      ],
    ]);
    const agent = new Agent({ systemPrompt: "sys" });
    const events = await collect(agent.run("hi", makeContext(llm)));
    const done = events.find((e) => e.type === "done") as { cachedPromptTokens: number };
    expect(done.cachedPromptTokens).toBe(4);
  });

  it("defaults cachedPromptTokens to 0 when usage omits it", async () => {
    const llm = scriptedLLM([textChunks("hi")]);
    const agent = new Agent({ systemPrompt: "sys" });
    const events = await collect(agent.run("hi", makeContext(llm)));
    const done = events.find((e) => e.type === "done") as { cachedPromptTokens: number };
    expect(done.cachedPromptTokens).toBe(0);
  });

  it("passes AgentConfig.modelParams through to llm.chat", async () => {
    const llm = scriptedLLM([textChunks("hi")]);
    const agent = new Agent({
      systemPrompt: "sys",
      modelParams: { temperature: 0.2, maxTokens: 500 },
    });
    await collect(agent.run("hi", makeContext(llm)));
    expect(llm.optsCalls[0]?.params).toEqual({ temperature: 0.2, maxTokens: 500 });
  });
});

describe("Agent outputSchema validation", () => {
  const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };

  it("yields an error when the final output is not valid JSON", async () => {
    const llm = scriptedLLM([textChunks("not json at all")]);
    const agent = new Agent({ systemPrompt: "sys", outputSchema: schema });
    const events = await collect(agent.run("hi", makeContext(llm)));
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("yields an error when JSON parses but violates the schema (missing required)", async () => {
    const llm = scriptedLLM([textChunks('{"subtitle":"x"}')]);
    const agent = new Agent({ systemPrompt: "sys", outputSchema: schema });
    const events = await collect(agent.run("hi", makeContext(llm)));
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("passes valid JSON output through without error", async () => {
    const llm = scriptedLLM([textChunks('{"title":"ok"}')]);
    const agent = new Agent({ systemPrompt: "sys", outputSchema: schema });
    const events = await collect(agent.run("hi", makeContext(llm)));
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("does nothing special when no outputSchema is configured", async () => {
    const llm = scriptedLLM([textChunks("free text")]);
    const agent = new Agent({ systemPrompt: "sys" });
    const events = await collect(agent.run("hi", makeContext(llm)));
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

/** Retriever that records its calls and replays fixed docs. */
function recordingRetriever(docs: Array<{ id: string; text: string }>) {
  const calls: Array<{ namespace: string; query: string }> = [];
  return {
    calls,
    async retrieve(namespace: string, query: string) {
      calls.push({ namespace, query });
      return docs;
    },
  };
}

describe("Agent.run parallel tool execution", () => {
  function concurrencyTool(name: string, parallelSafe: boolean, track: { active: number; max: number }): Tool {
    return {
      name,
      description: name,
      parameters: {},
      parallelSafe,
      async execute() {
        track.active++;
        track.max = Math.max(track.max, track.active);
        await new Promise((r) => setTimeout(r, 20));
        track.active--;
        return { content: `${name}-done` };
      },
    };
  }

  function twoToolCall(t1: string, t2: string): ChatChunk[] {
    return [
      { type: "tool_call", toolCall: { id: "a", name: t1, arguments: {} } },
      { type: "tool_call", toolCall: { id: "b", name: t2, arguments: {} } },
      { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
    ];
  }

  it("runs consecutive parallelSafe tool calls concurrently, results in order", async () => {
    const track = { active: 0, max: 0 };
    const registry = new ToolRegistry();
    registry.register(concurrencyTool("p1", true, track));
    registry.register(concurrencyTool("p2", true, track));
    const llm = scriptedLLM([twoToolCall("p1", "p2"), textChunks("done")]);

    const events = await collect(new Agent({ systemPrompt: "s" }).run("hi", makeContext(llm, registry)));

    expect(track.max).toBe(2); // both in flight at once
    const resultNames = events
      .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
      .map((e) => e.name);
    expect(resultNames).toEqual(["p1", "p2"]);
  });

  it("runs non-parallelSafe tool calls sequentially", async () => {
    const track = { active: 0, max: 0 };
    const registry = new ToolRegistry();
    registry.register(concurrencyTool("s1", false, track));
    registry.register(concurrencyTool("s2", false, track));
    const llm = scriptedLLM([twoToolCall("s1", "s2"), textChunks("done")]);

    await collect(new Agent({ systemPrompt: "s" }).run("hi", makeContext(llm, registry)));

    expect(track.max).toBe(1); // never overlapped
  });
});

describe("Agent.run user-memory injection cap", () => {
  it("caps injected user memory to at most 20 lines", async () => {
    const { AgentMemoryStore } = await import("../memory/store.js");
    const entries = Array.from({ length: 30 }, (_, i) => ({
      key: `k${i}`,
      value: `v${i}`,
      tier: "user" as const,
      createdAt: i,
    }));
    const adapter = {
      async get() { return undefined; },
      async set() {},
      async delete() {},
      async list() { return entries; },
      async search() { return []; },
    };
    const memory = new AgentMemoryStore({ persistent: adapter, userId: "u1" });
    const llm = scriptedLLM([textChunks("answer")]);
    const agent = new Agent({ systemPrompt: "sys" });

    await collect(agent.run("hi", { ...makeContext(llm), memory }));

    const systemText = llm.calls[0]
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n\n");
    // Isolate the [User Memory] section (system parts are joined by "\n\n").
    const section = systemText.split("[User Memory]")[1]?.split("\n\n")[0] ?? "";
    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(20);
  });
});

describe("Agent.run retrieval wiring", () => {
  it("retrieves with the user message and injects a [Retrieved Context] block", async () => {
    const llm = scriptedLLM([textChunks("answer")]);
    const retriever = recordingRetriever([
      { id: "1", text: "brand voice is playful" },
    ]);
    const agent = new Agent({ systemPrompt: "sys" });
    const ctx: AgentContext = {
      ...makeContext(llm),
      retriever,
      retrievalNamespace: "user:42:notes",
    };

    await collect(agent.run("what is our brand voice?", ctx));

    expect(retriever.calls).toEqual([
      { namespace: "user:42:notes", query: "what is our brand voice?" },
    ]);
    const systemText = llm.calls[0]
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n");
    expect(systemText).toContain("[Retrieved Context]");
    expect(systemText).toContain("brand voice is playful");
  });

  it("adds no retrieval block and does not retrieve when no retriever is configured", async () => {
    const llm = scriptedLLM([textChunks("answer")]);
    const agent = new Agent({ systemPrompt: "sys" });

    await collect(agent.run("hi", makeContext(llm)));

    const systemText = llm.calls[0]
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n");
    expect(systemText).not.toContain("[Retrieved Context]");
  });

  it("skips retrieval when the retriever returns no docs", async () => {
    const llm = scriptedLLM([textChunks("answer")]);
    const retriever = recordingRetriever([]);
    const agent = new Agent({ systemPrompt: "sys" });
    const ctx: AgentContext = {
      ...makeContext(llm),
      retriever,
      retrievalNamespace: "ns",
    };

    await collect(agent.run("hi", ctx));

    const systemText = llm.calls[0]
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n");
    expect(systemText).not.toContain("[Retrieved Context]");
  });
});
