import { describe, it, expect } from "vitest";
import { AgentMemoryStore } from "./store.js";
import type {
  SessionMemoryBackend,
  MemoryEntry,
  PersistentMemoryAdapter,
} from "./store.js";
import type { Retriever, VectorDoc } from "../retrieval/index.js";

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

class FakePersistentAdapter implements PersistentMemoryAdapter {
  searchCalls = 0;
  constructor(private searchResult: MemoryEntry[] = []) {}
  async get() {
    return undefined;
  }
  async set() {}
  async delete() {}
  async list() {
    return [];
  }
  async search(): Promise<MemoryEntry[]> {
    this.searchCalls++;
    return this.searchResult;
  }
}

function fakeRetriever(docs: VectorDoc[]): Retriever & { calls: number } {
  return {
    calls: 0,
    async retrieve(this: { calls: number }) {
      this.calls++;
      return docs;
    },
  } as Retriever & { calls: number };
}

describe("AgentMemoryStore.searchUserMemory retrieval", () => {
  it("uses the retriever (semantic) when one is configured and returns hits", async () => {
    const adapter = new FakePersistentAdapter([{ key: "ilike", value: "x", tier: "user", createdAt: 0 }]);
    const retriever = fakeRetriever([{ id: "m1", text: "playful brand voice", meta: { key: "voice" } }]);
    const store = new AgentMemoryStore({
      persistent: adapter,
      userId: "u1",
      retriever,
      retrievalNamespace: "user:u1:mem",
    });

    const results = await store.searchUserMemory("brand voice");

    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("voice");
    expect(results[0].value).toBe("playful brand voice");
    expect(adapter.searchCalls).toBe(0); // did not fall back to ILIKE
  });

  it("falls back to ILIKE search when the retriever returns nothing", async () => {
    const adapter = new FakePersistentAdapter([{ key: "k", value: "v", tier: "user", createdAt: 0 }]);
    const retriever = fakeRetriever([]);
    const store = new AgentMemoryStore({
      persistent: adapter,
      userId: "u1",
      retriever,
      retrievalNamespace: "user:u1:mem",
    });

    const results = await store.searchUserMemory("q");

    expect(adapter.searchCalls).toBe(1);
    expect(results[0].key).toBe("k");
  });

  it("uses ILIKE search when no retriever is configured", async () => {
    const adapter = new FakePersistentAdapter([{ key: "k", value: "v", tier: "user", createdAt: 0 }]);
    const store = new AgentMemoryStore({ persistent: adapter, userId: "u1" });

    await store.searchUserMemory("q");

    expect(adapter.searchCalls).toBe(1);
  });
});

describe("AgentMemoryStore.formatForPrompt injection caps", () => {
  it("caps session entries to at most 20 lines", () => {
    const store = new AgentMemoryStore();
    for (let i = 0; i < 30; i++) store.set("session", `k${i}`, `v${i}`);
    const prompt = store.formatForPrompt();
    const entryLines = prompt.split("\n").filter((l) => l.startsWith("- "));
    expect(entryLines.length).toBeLessThanOrEqual(20);
  });

  it("caps the total prompt length near the 4K char budget", () => {
    const store = new AgentMemoryStore();
    for (let i = 0; i < 20; i++) store.set("session", `k${i}`, "x".repeat(500));
    const prompt = store.formatForPrompt();
    expect(prompt.length).toBeLessThanOrEqual(4_500);
  });
});
