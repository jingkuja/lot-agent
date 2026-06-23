import { describe, it, expect, beforeEach } from "vitest";
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
