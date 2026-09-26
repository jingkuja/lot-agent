import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "./registry.js";
import { askUserTool } from "./ask-user.js";

afterEach(() => vi.useRealTimers());
const ctx = { workingDirectory: "/tmp" };

describe("tool execution boundaries", () => {
  it("rejects invalid nested items before executing an interactive tool", async () => {
    const registry = new ToolRegistry();
    registry.register(askUserTool);
    const result = await registry.execute("ask_user", { question: "Choose?", options: [{ label: "bad" }] }, ctx);
    expect(result).toMatchObject({ isError: true, errorKind: "validation" });
    expect(result.content).toContain("options/0");
  });

  it("aborts the attempt on timeout and never retries a write by default", async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    let committed = 0;
    let signal: AbortSignal | undefined;
    const execute = vi.fn(async (_input, context) => {
      signal = context.signal;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!signal?.aborted) committed++;
      return { content: "ok" };
    });
    registry.register({ name: "write", description: "", parameters: {}, execConfig: { timeoutMs: 10 }, execute });
    const pending = registry.execute("write", {}, ctx);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ isError: true });
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(committed).toBe(0);
  });

  it("contains a synchronous plugin exception and releases its timer", async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    registry.register({ name: "sync", description: "", parameters: {}, execute() { throw new Error("sync failure"); } });
    expect(await registry.execute("sync", {}, ctx)).toMatchObject({ isError: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("retries only explicitly retry-safe reads and cancels backoff promptly", async () => {
  vi.useFakeTimers();
  const registry = new ToolRegistry();
  const controller = new AbortController();
  const execute = vi.fn(async () => ({ content: "network", isError: true, errorKind: "network" as const }));
  registry.register({ name: "read", description: "", parameters: {}, retrySafe: true, execute });
  const pending = registry.execute("read", {}, ctx, { signal: controller.signal });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect(await pending).toMatchObject({ isError: true, errorKind: "cancelled" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
