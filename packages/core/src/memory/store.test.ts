import { describe, it, expect } from "vitest";
import { AgentMemoryStore } from "./store.js";
import type { SessionMemoryBackend, MemoryEntry } from "./store.js";

class FakeSessionBackend implements SessionMemoryBackend {
  store = new Map<string, MemoryEntry[]>();
  saveCount = 0;
  async load(cid: string): Promise<MemoryEntry[]> {
    return this.store.get(cid) ?? [];
  }
  async save(cid: string, entries: MemoryEntry[]): Promise<void> {
    this.saveCount++;
    this.store.set(cid, entries);
  }
}

describe("AgentMemoryStore session persistence", () => {
  it("session survives across instances sharing backend + conversationId", async () => {
    const backend = new FakeSessionBackend();
    const a = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    a.set("session", "pending", "confirm-delete");
    await Promise.resolve();
    const b = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    await b.hydrate();
    expect(b.get("session", "pending")).toBe("confirm-delete");
  });

  it("does not leak session across conversations", async () => {
    const backend = new FakeSessionBackend();
    const a = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    a.set("session", "k", "v");
    await Promise.resolve();
    const b = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c2" });
    await b.hydrate();
    expect(b.get("session", "k")).toBeUndefined();
  });

  it("ephemeral is not persisted to the backend", async () => {
    const backend = new FakeSessionBackend();
    const a = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    a.set("ephemeral", "tmp", "x");
    await Promise.resolve();
    expect(backend.saveCount).toBe(0);
  });

  it("delete on session flushes to backend", async () => {
    const backend = new FakeSessionBackend();
    const a = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    a.set("session", "k", "v");
    await Promise.resolve();
    a.delete("session", "k");
    await Promise.resolve();
    const b = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    await b.hydrate();
    expect(b.get("session", "k")).toBeUndefined();
  });
});
