import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryAgentRegistry } from "./registry.js";
import type { AgentDefinition } from "./types.js";

const makeDef = (id: string): AgentDefinition => ({
  id,
  name: `Agent ${id}`,
  type: "general",
  description: `Test agent ${id}`,
  systemPrompt: `You are ${id}.`,
  toolNames: [],
  defaultModelId: "deepseek-v4-flash",
});

describe("InMemoryAgentRegistry", () => {
  let registry: InMemoryAgentRegistry;

  beforeEach(() => {
    registry = new InMemoryAgentRegistry();
  });

  it("get returns undefined for unknown id", () => {
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("register then get returns the definition", () => {
    const def = makeDef("general");
    registry.register(def);
    expect(registry.get("general")).toEqual(def);
  });

  it("list returns all registered definitions", () => {
    const a = makeDef("a");
    const b = makeDef("b");
    registry.register(a);
    registry.register(b);
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list).toContainEqual(a);
    expect(list).toContainEqual(b);
  });

  it("registering the same id overwrites the previous definition", () => {
    const first = makeDef("general");
    const second = { ...makeDef("general"), name: "Updated" };
    registry.register(first);
    registry.register(second);
    expect(registry.get("general")?.name).toBe("Updated");
    expect(registry.list()).toHaveLength(1);
  });

  it("list returns empty array when nothing registered", () => {
    expect(registry.list()).toEqual([]);
  });
});
