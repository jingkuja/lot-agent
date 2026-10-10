import { describe, it, expect, vi } from "vitest";
import { SkillLoader, ToolRegistry } from "@lot-agent/core";
import type { ChatChunk, Message } from "@lot-agent/core";
import { AgentService } from "./agent-service.js";

/** LLM that replays a script of chunk-lists; one list per chat() call. */
function scriptedLLM(script: ChatChunk[][], calls: Message[][] = []) {
  let i = 0;
  return {
    async *chat(_messages: Message[]): AsyncIterable<ChatChunk> {
      calls.push(structuredClone(_messages));
      const chunks =
        script[i++] ?? [{ type: "done", usage: { promptTokens: 1, completionTokens: 1 } }];
      for (const c of chunks) yield c;
    },
  };
}

/** Two parallel-safe same-name tool calls, then a plain-text closing turn. */
function parallelSameNameScript(): ChatChunk[][] {
  return [
    [
      { type: "tool_call", toolCall: { id: "a", name: "fetchy", arguments: { u: 1 } } },
      { type: "tool_call", toolCall: { id: "b", name: "fetchy", arguments: { u: 2 } } },
      { type: "done", usage: { promptTokens: 7, completionTokens: 3 } },
    ],
    [
      { type: "text", content: "done" },
      { type: "done", usage: { promptTokens: 5, completionTokens: 2 } },
    ],
  ];
}

/** streamAgentResponse 的最小假 this:只带该方法用到的依赖。 */
function fakeService(opts: {
  script: ChatChunk[][];
  conversationModel?: string | null;
}) {
  const calls: Message[][] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "fetchy",
    description: "parallel-safe test tool",
    parameters: {},
    parallelSafe: true,
    async execute(input: unknown) {
      return { content: `out-${(input as { u: number }).u}` };
    },
  });

  const repo = {
    saveUserMessage: vi.fn(async () => "um1"),
    loadHistory: vi.fn(async () => []),
    saveAssistantWithToolCalls: vi.fn(async () => "am1"),
    saveToolResult: vi.fn(async () => {}),
    saveFinalAssistant: vi.fn(async () => {}),
  };
  const usageMeter = { record: vi.fn(async () => 0.01) };
  const recorder = {
    start: vi.fn(),
    startLlmSpan: vi.fn(),
    endLlmSpan: vi.fn(),
    startToolSpan: vi.fn(),
    endToolSpan: vi.fn(),
    finish: vi.fn(async () => {}),
    traceObject: { metadata: {} as Record<string, unknown> },
  };

  const fake = {
    agentRegistry: {
      get: () => ({
        id: "general",
        name: "通用助手",
        type: "general",
        description: "",
        systemPrompt: "sys",
        toolNames: ["fetchy"],
        defaultModelId: "m-default",
      }),
    },
    messageRepo: repo,
    skillLoader: new SkillLoader(),
    db: {
      getConversation: vi.fn(async () => ({
        id: "c1",
        model: opts.conversationModel ?? null,
        metadata: {},
      })),
      setConversationModel: vi.fn(async () => {}),
      getUserApiKey: vi.fn(async () => null),
      mergeConversationMetadata: vi.fn(async () => {}),
    },
    providerFactory: { llm: vi.fn() },
    modelRegistry: {
      getProvider: () => scriptedLLM(opts.script, calls),
      getConfig: () => undefined,
    },
    agentConfig: {},
    llmConfig: {
      default: "openai",
      openai: { model: "m-env" },
      anthropic: { model: "m-env-anthropic" },
    },
    toolRegistry: registry,
    pgAdapter: {
      async get() { return undefined; },
      async set() {},
      async delete() {},
      async list() { return []; },
      async search() { return []; },
    },
    sessionBackend: undefined,
    jobQueue: { enqueue: vi.fn(async () => "job1") },
    usageMeter,
    traceRecorderFactory: () => recorder,
    streamAgentResponse: AgentService.prototype.streamAgentResponse,
  };
  return { fake: fake as unknown as AgentService, repo, usageMeter, calls };
}

async function drain(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("streamAgentResponse tool-result persistence", () => {
  it("persists timeout as a timeout with visible error content", async () => {
    const { fake, repo } = fakeService({ script: [] });
    (fake as any).agentConfig = { maxRunTimeMs: 10 };
    (fake as any).modelRegistry.getProvider = () => ({ async *chat() { await new Promise(() => {}); } });
    const events = await drain(fake.streamAgentResponse("c1", "hi", "general", "u1"));
    expect(events.at(-1)).toMatchObject({ status: "timed_out" });
    expect((repo.saveFinalAssistant.mock.calls[0] as unknown[])[1]).toContain("timed out");
    expect((repo.saveFinalAssistant.mock.calls[0] as unknown[])[5]).toMatchObject({ status: "timed_out" });
  });

  it("persists every parallel tool result, paired by toolCallId (same-name tools)", async () => {
    const { fake, repo } = fakeService({ script: parallelSameNameScript() });

    await drain(fake.streamAgentResponse("c1", "hi", "general", "u1"));

    // One assistant message carrying BOTH tool calls…
    expect(repo.saveAssistantWithToolCalls).toHaveBeenCalledTimes(1);
    const savedCalls = repo.saveAssistantWithToolCalls.mock.calls[0][2] as {
      id: string;
    }[];
    expect(savedCalls.map((tc) => tc.id)).toEqual(["a", "b"]);
    // …and BOTH results persisted, each under its own call id.
    expect(repo.saveToolResult).toHaveBeenCalledTimes(2);
    expect(repo.saveToolResult.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["a", "out-1"],
      ["b", "out-2"],
    ]);
  });
});

describe("streamAgentResponse usage metering", () => {
  it("records usage under the turn's resolved model, not the agent default", async () => {
    const { fake, usageMeter } = fakeService({
      script: parallelSameNameScript(),
      conversationModel: "m-conv",
    });

    await drain(
      fake.streamAgentResponse("c1", "hi", "general", "u1", undefined, undefined, {
        modelId: "m-explicit",
      })
    );

    expect(usageMeter.record).toHaveBeenCalledTimes(2);
    expect(usageMeter.record.mock.calls[0][0]).toMatchObject({
      userId: "u1",
      modelId: "m-explicit",
      usage: { inputCount: 7, outputCount: 3 },
    });
  });

  it("falls back to the conversation's stored model when no explicit pick", async () => {
    const { fake, usageMeter } = fakeService({
      script: parallelSameNameScript(),
      conversationModel: "m-conv",
    });

    await drain(fake.streamAgentResponse("c1", "hi", "general", "u1"));

    expect(usageMeter.record.mock.calls[0][0]).toMatchObject({ modelId: "m-conv" });
  });
});

describe("streamAgentResponse digital employee scope", () => {
  it("fail-closes to no tools when the conversation has no legal featureScope", async () => {
    const { fake } = fakeService({
      script: [[{ type: "text", content: "ok" }, { type: "done", usage: { promptTokens: 1, completionTokens: 1 } }]],
    });
    (fake as any).agentRegistry = {
      get: () => ({
        id: "digital_employee",
        name: "数字员工",
        type: "digital_employee",
        description: "",
        systemPrompt: "sys",
        toolNames: ["search_customer_profiles", "generate_campaign_copy", "fetchy"],
        defaultModelId: "m-default",
      }),
    };
    const userLlm = scriptedLLM([
      [{ type: "text", content: "ok" }, { type: "done", usage: { promptTokens: 1, completionTokens: 1 } }],
    ]);
    const resolveDigitalEmployeeLLM = vi.fn(async () => ({
      llm: userLlm,
      usedModelId: "m-user-tokenhub",
      modelIds: ["m-user-tokenhub"],
    }));
    (fake as any).resolveDigitalEmployeeLLM = resolveDigitalEmployeeLLM;
    const toLLMTools = vi.spyOn((fake as any).toolRegistry, "toLLMTools");

    await drain(fake.streamAgentResponse("c1", "hi", "digital_employee", "u1"));

    expect(toLLMTools).toHaveBeenCalledWith([]);
    expect(resolveDigitalEmployeeLLM).toHaveBeenCalledWith("u1", null);
    expect((fake as any).jobQueue.enqueue).not.toHaveBeenCalled();
  });
});


it("records known usage even when final message persistence fails", async () => {
  const { fake, repo, usageMeter } = fakeService({ script: [[
    { type: "text", content: "finished" },
    { type: "done", usage: { promptTokens: 12, completionTokens: 5 } },
  ]] });
  repo.saveFinalAssistant.mockRejectedValueOnce(new Error("save failed"));
  await expect(drain(fake.streamAgentResponse("c1", "hi", "general", "u1"))).rejects.toThrow("save failed");
  expect(usageMeter.record).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputCount: 12, outputCount: 5 } }));
});


it("includes response language policy even with an overridden agent prompt", async () => {
  const { fake, calls } = fakeService({ script: [[{ type: "done", usage: { promptTokens: 1, completionTokens: 1 } }]] });
  await drain(fake.streamAgentResponse("c1", "Tolong bantu saya membuat presentasi", "general", "u1"));
  const system = calls[0].filter((message) => message.role === "system").map((message) => message.content).join("\n");
  expect(system).toContain("sys");
  expect(system).toContain("match the latest substantive user request");
  expect(system).toContain("Do not choose Chinese just because tool results");
  expect(calls[0].some((message) => message.role === "user" && String(message.content).includes("Tolong bantu saya"))).toBe(true);
});
