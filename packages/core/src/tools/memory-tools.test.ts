import { describe, it, expect } from "vitest";
import { createMemoryTools } from "./memory-tools.js";
import { AgentMemoryStore } from "../memory/store.js";
import type { PersistentMemoryAdapter, MemoryEntry } from "../memory/store.js";
import type { ToolContext } from "../types/index.js";

class FakePersistent implements PersistentMemoryAdapter {
  store = new Map<string, string>();
  async get(u: string, k: string) { return this.store.get(`${u}:${k}`); }
  async set(u: string, k: string, v: string) { this.store.set(`${u}:${k}`, v); }
  async delete(u: string, k: string) { this.store.delete(`${u}:${k}`); }
  async list(): Promise<MemoryEntry[]> { return []; }
  async search(): Promise<MemoryEntry[]> { return []; }
}

const tool = (name: string) => createMemoryTools().find((t) => t.name === name)!;

describe("memory_delete tool", () => {
  it("registers four memory tools in order", () => {
    expect(createMemoryTools().map((t) => t.name)).toEqual([
      "memory_read",
      "memory_write",
      "memory_list",
      "memory_delete",
    ]);
  });

  it("deletes user memory via the await path", async () => {
    const persistent = new FakePersistent();
    const memory = new AgentMemoryStore({ persistent, userId: "u1" });
    await memory.setUserMemory("brand_name", "Acme");
    const ctx: ToolContext = { workingDirectory: "/", memory };
    const res = await tool("memory_delete").execute({ tier: "user", key: "brand_name" }, ctx);
    expect(res.content).toContain("brand_name");
    expect(await memory.getUserMemory("brand_name")).toBeUndefined();
  });

  it("deletes session memory", async () => {
    const memory = new AgentMemoryStore({});
    memory.set("session", "pending", "x");
    const ctx: ToolContext = { workingDirectory: "/", memory };
    await tool("memory_delete").execute({ tier: "session", key: "pending" }, ctx);
    expect(memory.get("session", "pending")).toBeUndefined();
  });

  it("errors when memory is unavailable", async () => {
    const ctx = { workingDirectory: "/" } as ToolContext;
    const res = await tool("memory_delete").execute({ tier: "user", key: "k" }, ctx);
    expect(res.isError).toBe(true);
  });
});
