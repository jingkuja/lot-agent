import { describe, it, expect } from "vitest";
import { failedInteractiveNames } from "./interactive-tools.js";
import type { DisplayMessage } from "../hooks/chat-reducer.js";

const outlineCall = { name: "propose_outline", input: { title: "T" } };

const asst = (id: string, toolCalls?: DisplayMessage["toolCalls"]): DisplayMessage => ({
  id,
  role: "assistant",
  content: "",
  toolCalls,
});
const toolMsg = (name: string, isError: boolean): DisplayMessage => ({
  id: `tr-${name}-${isError}`,
  role: "tool",
  content: "",
  toolResult: { name, output: isError ? "校验失败" : "ok", isError },
});
const user = (content: string): DisplayMessage => ({ id: `u-${content}`, role: "user", content });

describe("failedInteractiveNames", () => {
  it("flags an interactive call whose adjacent tool result errored", () => {
    const messages = [asst("a1", [outlineCall]), toolMsg("propose_outline", true)];
    expect(failedInteractiveNames(messages, 0)).toEqual(["propose_outline"]);
  });

  it("returns empty for a successful call", () => {
    const messages = [asst("a1", [outlineCall]), toolMsg("propose_outline", false)];
    expect(failedInteractiveNames(messages, 0)).toEqual([]);
  });

  it("the retry after a failure is NOT flagged (validation-failure → retry sequence)", () => {
    // seq 5..8 of the real bug: failed proposal, error result, retried proposal, ok result.
    const messages = [
      asst("a5", [outlineCall]),
      toolMsg("propose_outline", true),
      asst("a7", [outlineCall]),
      toolMsg("propose_outline", false),
      user("确认，按此大纲生成"),
    ];
    expect(failedInteractiveNames(messages, 0)).toEqual(["propose_outline"]);
    expect(failedInteractiveNames(messages, 2)).toEqual([]);
  });

  it("stops scanning at the first non-tool message — a later failure is not attributed backwards", () => {
    const messages = [
      asst("a1", [outlineCall]),
      toolMsg("propose_outline", false),
      user("改一下第 3 页"),
      asst("a2", [outlineCall]),
      toolMsg("propose_outline", true),
    ];
    expect(failedInteractiveNames(messages, 0)).toEqual([]);
    expect(failedInteractiveNames(messages, 3)).toEqual(["propose_outline"]);
  });

  it("ignores non-interactive tool failures on the same message", () => {
    const messages = [
      asst("a1", [{ name: "web_search", input: {} }]),
      toolMsg("web_search", true),
    ];
    expect(failedInteractiveNames(messages, 0)).toEqual([]);
  });

  it("handles ask_user and messages without tool calls", () => {
    const askCall = { name: "ask_user", input: { question: "?" } };
    const messages = [asst("a1", [askCall]), toolMsg("ask_user", true)];
    expect(failedInteractiveNames(messages, 0)).toEqual(["ask_user"]);
    expect(failedInteractiveNames([asst("a2"), user("hi")], 0)).toEqual([]);
    expect(failedInteractiveNames([], 0)).toEqual([]);
  });
});
