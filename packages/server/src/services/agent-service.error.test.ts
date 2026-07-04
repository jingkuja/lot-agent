import { describe, it, expect } from "vitest";
import { buildFinalAssistantContent } from "./agent-service.js";

describe("buildFinalAssistantContent", () => {
  it("returns content unchanged when there is no error", () => {
    expect(buildFinalAssistantContent("hello", null, false)).toBe("hello");
    expect(buildFinalAssistantContent("hello", undefined, false)).toBe("hello");
    expect(buildFinalAssistantContent("", null, false)).toBe("");
  });

  it("appends the error to partial content so it persists", () => {
    expect(buildFinalAssistantContent("partial reply", "LLM error: boom", false)).toBe(
      "partial reply\n\n[Error: LLM error: boom]"
    );
  });

  it("persists the error alone when no content was produced", () => {
    expect(buildFinalAssistantContent("", "boom", false)).toBe("[Error: boom]");
  });

  it("does not persist an error for a user-initiated cancellation", () => {
    expect(buildFinalAssistantContent("partial", "Agent run cancelled", true)).toBe(
      "partial"
    );
    expect(buildFinalAssistantContent("", "Agent run cancelled", true)).toBe("");
  });
});
