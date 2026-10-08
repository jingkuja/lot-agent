import { expect, it, vi } from "vitest";
import { exportConfirmedPpt } from "./ppt-confirmation.js";

it("exports the exact edited deck once, persists its paired messages and reports zero LLM usage", async () => {
  const deck = { title: "已确认", themePreset: "warm" as const, slides: [{ layout: "content" as const, title: "修改后的结论", bullets: ["保留的事实"] }] };
  const execute = vi.fn(async (_input: unknown) => ({ content: "download" }));
  const repo = { saveAssistantWithToolCalls: vi.fn(), saveToolResult: vi.fn() };
  const events = [];
  for await (const event of exportConfirmedPpt(deck, { name: "generate_ppt", execute } as any, repo, { userId: "owner", conversationId: "chat", workingDirectory: "/tmp" })) events.push(event);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0][0]).toEqual(deck);
  expect(repo.saveToolResult).toHaveBeenCalledWith("chat", expect.any(String), "download", undefined);
  expect(events.at(-1)).toMatchObject({ type: "done", totalTokens: 0 });
});

it("persists a retryable failure when export throws", async () => {
  const repo = { saveAssistantWithToolCalls: vi.fn(), saveToolResult: vi.fn() };
  const events = [];
  for await (const event of exportConfirmedPpt({ title: "T", slides: [] }, { name: "generate_ppt", execute: async () => { throw new Error("disk unavailable"); } } as any, repo, { conversationId: "chat", workingDirectory: "/tmp" })) events.push(event);
  expect(repo.saveToolResult).toHaveBeenCalledWith("chat", expect.any(String), expect.stringContaining("failed"), true);
  expect(events.at(-1)).toMatchObject({ status: "failed" });
});
