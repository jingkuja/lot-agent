import { describe, it, expect } from "vitest";
import { agentEventToSse } from "./sse-adapter.js";

describe("agentEventToSse", () => {
  it("maps text event", () => {
    expect(agentEventToSse({ type: "text", content: "hi" })).toEqual({
      type: "text",
      content: "hi",
    });
  });

  it("maps tool_call event", () => {
    expect(
      agentEventToSse({
        type: "tool_call",
        id: "t1",
        name: "read_file",
        input: { path: "a" },
      })
    ).toEqual({
      type: "tool_call",
      id: "t1",
      name: "read_file",
      input: { path: "a" },
    });
  });

  it("maps tool_result event", () => {
    expect(
      agentEventToSse({
        type: "tool_result",
        name: "read_file",
        output: "x",
        isError: false,
      })
    ).toEqual({
      type: "tool_result",
      name: "read_file",
      output: "x",
      isError: false,
    });
  });

  it("maps done event", () => {
    expect(
      agentEventToSse({
        type: "done",
        iterations: 2,
        totalTokens: 10,
        inputTokens: 6,
        outputTokens: 4,
      })
    ).toEqual({
      type: "done",
      iterations: 2,
      totalTokens: 10,
      inputTokens: 6,
      outputTokens: 4,
    });
  });

  it("maps error event", () => {
    expect(agentEventToSse({ type: "error", message: "boom" })).toEqual({
      type: "error",
      message: "boom",
    });
  });

  it("maps artifact event", () => {
    expect(
      agentEventToSse({
        type: "artifact",
        assetId: "a1",
        url: "/static/assets/a1.png",
        mediaType: "image/png",
      })
    ).toEqual({
      type: "artifact",
      assetId: "a1",
      url: "/static/assets/a1.png",
      mediaType: "image/png",
    });
  });
});
