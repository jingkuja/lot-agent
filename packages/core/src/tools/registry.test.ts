import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { Tool, ToolContext } from "../types/index.js";

const makeTool = (name: string): Tool => ({
  name,
  description: `Tool ${name}`,
  parameters: { type: "object", properties: {} },
  execute: async (_input: unknown, _ctx: ToolContext) => ({ content: "ok" }),
});

describe("ToolRegistry.toLLMTools", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeTool("read_file"));
    registry.register(makeTool("write_file"));
    registry.register(makeTool("web_search"));
  });

  it("toLLMTools() with no args returns all tools", () => {
    expect(registry.toLLMTools()).toHaveLength(3);
  });

  it("toLLMTools(names) returns only the named tools", () => {
    const result = registry.toLLMTools(["read_file"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
  });

  it("toLLMTools([]) returns empty array", () => {
    expect(registry.toLLMTools([])).toHaveLength(0);
  });

  it("toLLMTools with unknown names are ignored", () => {
    const result = registry.toLLMTools(["read_file", "unknown_tool"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
  });

  it("toLLMTools preserves registry order", () => {
    const result = registry.toLLMTools(["web_search", "read_file"]);
    // Registry order is: read_file, write_file, web_search
    // Result should follow registry order (read_file before web_search)
    expect(result.map((t) => t.name)).toEqual(["read_file", "web_search"]);
  });
});

describe("ToolRegistry.execute — input validation", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };

  it("rejects input missing a required field before calling execute", async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.register({
      name: "read_file",
      description: "reads a file",
      parameters: schema,
      execute: async () => {
        executed = true;
        return { content: "ok" };
      },
    });
    const result = await registry.execute("read_file", {}, { workingDirectory: "/tmp" });
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("validation");
    expect(executed).toBe(false);
  });

  it("runs the tool when input is valid", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "reads a file",
      parameters: schema,
      execute: async () => ({ content: "ok" }),
    });
    const result = await registry.execute(
      "read_file",
      { path: "a.txt" },
      { workingDirectory: "/tmp" }
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("ok");
  });
});

describe("ToolRegistry.execute — timer cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the per-call timeout timer once the tool resolves normally", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "fast",
      description: "a fast tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
    });

    const result = await registry.execute("fast", {}, { workingDirectory: "/tmp" });

    expect(result.content).toBe("ok");
    // The timeout() race timer must be cancelled once the tool wins the race —
    // otherwise every call leaves a live setTimeout hanging until timeoutMs.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer even when a signal is passed alongside the call", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "fast",
      description: "a fast tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
    });
    const controller = new AbortController();

    const result = await registry.execute(
      "fast",
      {},
      { workingDirectory: "/tmp" },
      { signal: controller.signal }
    );

    expect(result.content).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});
