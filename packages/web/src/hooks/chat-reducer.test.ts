import { describe, it, expect } from "vitest";
import {
  chatReducer,
  initialChatState,
  type ChatAction,
  type ChatState,
  type DisplayMessage,
} from "./chat-reducer.js";

function run(actions: ChatAction[], from: ChatState = initialChatState): ChatState {
  return actions.reduce(chatReducer, from);
}

const user = (id: string, content = "hi"): DisplayMessage => ({ id, role: "user", content });
const assistant = (id: string, content: string, extra: Partial<DisplayMessage> = {}): DisplayMessage => ({
  id,
  role: "assistant",
  content,
  ...extra,
});

describe("chatReducer — plain text turn", () => {
  it("accumulating upserts keep one bubble, finalize on turn end", () => {
    const s = run([
      { type: "stream_started" },
      { type: "user_appended", message: user("u1") },
      { type: "assistant_upserted", message: assistant("a1", "Hel") },
      { type: "assistant_upserted", message: assistant("a1", "Hello") },
      { type: "turn_finalized", message: assistant("a1", "Hello") },
    ]);
    expect(s.isStreaming).toBe(false);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]).toMatchObject({ id: "a1", content: "Hello", isStreaming: false });
  });

  it("streaming upsert marks the bubble as streaming", () => {
    const s = run([{ type: "assistant_upserted", message: assistant("a1", "x") }]);
    expect(s.messages[0].isStreaming).toBe(true);
    expect(s.isStreaming).toBe(false); // stream_started is a separate action
  });

  it("thinking accumulates alongside content on the same bubble", () => {
    const s = run([
      { type: "assistant_upserted", message: assistant("a1", "", { thinking: "hmm" }) },
      { type: "assistant_upserted", message: assistant("a1", "ok", { thinking: "hmm…" }) },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ thinking: "hmm…", content: "ok" });
  });

  it("an empty bubble is dropped on turn end; a thinking-only bubble too", () => {
    const empty = run([
      { type: "assistant_upserted", message: assistant("a1", "") },
      { type: "turn_finalized", message: assistant("a1", "") },
    ]);
    expect(empty.messages).toHaveLength(0);

    const thinkingOnly = run([
      { type: "assistant_upserted", message: assistant("a1", "", { thinking: "…" }) },
      { type: "turn_finalized", message: assistant("a1", "", { thinking: "…" }) },
    ]);
    expect(thinkingOnly.messages).toHaveLength(0);
  });

  it("finalizing twice (done then stream_end) is idempotent", () => {
    const done = assistant("a1", "Hello");
    const once = run([
      { type: "assistant_upserted", message: done },
      { type: "turn_finalized", message: done },
    ]);
    const twice = chatReducer(once, { type: "turn_finalized", message: done });
    expect(twice.messages).toEqual(once.messages);
  });

  it("an error turn keeps the bubble because the error text is content", () => {
    const errored = assistant("a1", "partial\n\n[Error: boom]");
    const s = run([
      { type: "stream_started" },
      { type: "assistant_upserted", message: assistant("a1", "partial") },
      { type: "turn_finalized", message: errored },
    ]);
    expect(s.isStreaming).toBe(false);
    expect(s.messages[0].content).toContain("[Error: boom]");
    expect(s.messages[0].isStreaming).toBe(false);
  });

  it("an error before any delta creates the bubble (upsert on absent id)", () => {
    const s = run([
      { type: "turn_finalized", message: assistant("a1", "\n\n[Error: boom]") },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].content).toContain("[Error: boom]");
  });
});

describe("chatReducer — tool calls", () => {
  it("tool result finalizes the calling bubble and appends a card; next turn is a new bubble", () => {
    const withCall = assistant("a1", "", { toolCalls: [{ name: "web_fetch", input: { url: "u" } }] });
    const s = run([
      { type: "assistant_upserted", message: withCall },
      { type: "tool_result_appended", assistantId: "a1", cardId: "tool-result-tc1-web_fetch", name: "web_fetch", output: "body", isError: false },
      { type: "assistant_upserted", message: assistant("a2", "Answer") },
      { type: "turn_finalized", message: assistant("a2", "Answer") },
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(["a1", "tool-result-tc1-web_fetch", "a2"]);
    expect(s.messages[0].isStreaming).toBe(false);
    expect(s.messages[1]).toMatchObject({
      role: "tool",
      toolResult: { name: "web_fetch", output: "body", isError: false },
    });
    expect(s.messages[2]).toMatchObject({ content: "Answer", isStreaming: false });
  });

  it("parallel same-name tools: second result appends its own card even though its assistant id is absent", () => {
    const twoCalls = assistant("a1", "", {
      toolCalls: [
        { name: "web_fetch", input: { url: "1" } },
        { name: "web_fetch", input: { url: "2" } },
      ],
    });
    const s = run([
      { type: "assistant_upserted", message: twoCalls },
      { type: "tool_result_appended", assistantId: "a1", cardId: "tool-result-tc1-web_fetch", name: "web_fetch", output: "one", isError: false },
      // the closure has already rotated to a fresh (never-upserted) assistant id
      { type: "tool_result_appended", assistantId: "a2", cardId: "tool-result-tc2-web_fetch", name: "web_fetch", output: "two", isError: false },
    ]);
    expect(s.messages.map((m) => m.id)).toEqual([
      "a1",
      "tool-result-tc1-web_fetch",
      "tool-result-tc2-web_fetch",
    ]);
    expect(s.messages[2].toolResult?.output).toBe("two");
  });

  it("a bubble with tool calls but no text survives turn end", () => {
    const withCall = assistant("a1", "", { toolCalls: [{ name: "ask_user", input: {} }] });
    const s = run([
      { type: "assistant_upserted", message: withCall },
      { type: "turn_finalized", message: withCall },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].toolCalls).toHaveLength(1);
  });
});

describe("chatReducer — snapshot / clear / truncate", () => {
  it("snapshot replaces messages, model and streaming flag wholesale", () => {
    const s = run(
      [
        {
          type: "snapshot_loaded",
          messages: [user("u1"), assistant("a1", "old", { isStreaming: false })],
          model: "gpt-x",
          isStreaming: true,
        },
      ],
      { messages: [user("stale")], conversationModel: "other", isStreaming: false }
    );
    expect(s.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(s.conversationModel).toBe("gpt-x");
    expect(s.isStreaming).toBe(true);
  });

  it("cleared resets to the initial state", () => {
    const s = run(
      [{ type: "cleared" }],
      { messages: [user("u1")], conversationModel: "m", isStreaming: true }
    );
    expect(s).toEqual(initialChatState);
  });

  it("truncated_from cuts from the LAST occurrence of the id, inclusive", () => {
    const base: ChatState = {
      messages: [user("u1"), assistant("a1", "x"), user("u2"), assistant("a2", "y")],
      conversationModel: null,
      isStreaming: false,
    };
    const s = chatReducer(base, { type: "truncated_from", id: "u2" });
    expect(s.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("truncated_from with an unknown id is a no-op", () => {
    const base: ChatState = { messages: [user("u1")], conversationModel: null, isStreaming: false };
    expect(chatReducer(base, { type: "truncated_from", id: "nope" })).toBe(base);
  });
});

describe("chatReducer — generation lifecycle", () => {
  const optimistic = (): ChatAction => ({
    type: "generation_pair_appended",
    userMessage: user("tmp-u", "a cat"),
    genMessage: {
      id: "tmp-g",
      role: "assistant",
      content: "",
      generation: { mediaType: "image", status: "generating", progress: 0 },
    },
  });

  it("optimistic pair → reconcile ids → progress → completed", () => {
    const s = run([
      { type: "stream_started" },
      optimistic(),
      {
        type: "generation_ids_reconciled",
        tempUserId: "tmp-u",
        userMessageId: "u-db",
        tempGenId: "tmp-g",
        assistantMessageId: "g-db",
        generation: { mediaType: "image", status: "generating", progress: 0, supportsProgress: true, taskId: "t1" },
      },
      { type: "generation_progress", messageId: "g-db", progress: 40 },
      {
        type: "generation_finished",
        messageId: "g-db",
        generation: { mediaType: "image", status: "completed", progress: 100, assets: [{ url: "/a.png", mime: "image/png" }], taskId: "t1" },
      },
    ]);
    expect(s.isStreaming).toBe(false);
    const gen = s.messages.find((m) => m.id === "g-db");
    expect(s.messages.find((m) => m.id === "u-db")?.dbId).toBe("u-db");
    expect(gen?.dbId).toBe("g-db");
    expect(gen?.generation).toMatchObject({ status: "completed", assets: [{ url: "/a.png" }] });
  });

  it("progress keeps existing generation fields (taskId, supportsProgress) and forces status generating", () => {
    const s = run([
      optimistic(),
      {
        type: "generation_ids_reconciled",
        tempUserId: "tmp-u",
        userMessageId: "u-db",
        tempGenId: "tmp-g",
        assistantMessageId: "g-db",
        generation: { mediaType: "image", status: "generating", progress: 0, supportsProgress: true, taskId: "t1" },
      },
      { type: "generation_progress", messageId: "g-db", progress: 60 },
    ]);
    expect(s.messages.find((m) => m.id === "g-db")?.generation).toMatchObject({
      status: "generating",
      progress: 60,
      supportsProgress: true,
      taskId: "t1",
    });
  });

  it("progress on a message without generation state is a no-op", () => {
    const base: ChatState = {
      messages: [assistant("a1", "plain")],
      conversationModel: null,
      isStreaming: false,
    };
    const s = chatReducer(base, { type: "generation_progress", messageId: "a1", progress: 10 });
    expect(s.messages[0].generation).toBeUndefined();
  });

  it("a failed create request flips the still-optimistic bubble to failed and unlocks input", () => {
    const s = run([
      { type: "stream_started" },
      optimistic(),
      {
        type: "generation_finished",
        messageId: "tmp-g",
        generation: { mediaType: "image", status: "failed", error: "生成请求失败：500" },
      },
    ]);
    expect(s.isStreaming).toBe(false);
    expect(s.messages.find((m) => m.id === "tmp-g")?.generation).toMatchObject({
      status: "failed",
      error: "生成请求失败：500",
    });
  });

  it("cancelled terminal state replaces the generation view wholesale", () => {
    const s = run([
      optimistic(),
      {
        type: "generation_finished",
        messageId: "tmp-g",
        generation: { mediaType: "image", status: "cancelled", progress: 100, taskId: "t1" },
      },
    ]);
    expect(s.messages.find((m) => m.id === "tmp-g")?.generation?.status).toBe("cancelled");
  });
});
