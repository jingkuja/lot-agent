import { describe, it, expect } from "vitest";
import { lastTurn } from "./last-turn.js";

describe("lastTurn", () => {
  it("pairs the last assistant reply with the preceding user message", () => {
    const t = lastTurn([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);
    expect(t).toEqual({ userMessage: "u2", assistantText: "a2" });
  });

  it("skips empty assistant messages (e.g. tool-call placeholders)", () => {
    const t = lastTurn([
      { role: "user", content: "u1" },
      { role: "assistant", content: "" },
      { role: "tool", content: "result" },
      { role: "assistant", content: "final" },
    ]);
    expect(t).toEqual({ userMessage: "u1", assistantText: "final" });
  });

  it("returns null when there is no assistant message", () => {
    expect(lastTurn([{ role: "user", content: "u1" }])).toBeNull();
  });

  it("returns empty userMessage when no preceding user exists", () => {
    expect(lastTurn([{ role: "assistant", content: "a" }])).toEqual({
      userMessage: "",
      assistantText: "a",
    });
  });
});
