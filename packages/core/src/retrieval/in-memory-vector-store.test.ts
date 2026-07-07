import { describe, it, expect } from "vitest";
import { InMemoryVectorStore } from "./in-memory-vector-store.js";

describe("InMemoryVectorStore", () => {
  it("ranks docs by cosine similarity and honors topK", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("ns", [
      { id: "a", text: "apple", vector: [1, 0] },
      { id: "b", text: "banana", vector: [0, 1] },
      { id: "c", text: "cherry", vector: [0.9, 0.1] },
    ]);

    const results = await store.query("ns", [1, 0], 2);

    expect(results.map((r) => r.id)).toEqual(["a", "c"]);
    expect(results[0].score).toBeCloseTo(1);
    expect(results[0].text).toBe("apple");
  });

  it("overwrites a doc that is upserted with the same id", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("ns", [{ id: "a", text: "old", vector: [1, 0] }]);
    await store.upsert("ns", [{ id: "a", text: "new", vector: [0, 1] }]);

    const results = await store.query("ns", [0, 1], 5);

    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("new");
  });

  it("deletes docs by id", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("ns", [
      { id: "a", text: "a", vector: [1, 0] },
      { id: "b", text: "b", vector: [0, 1] },
    ]);

    await store.delete("ns", ["a"]);
    const results = await store.query("ns", [1, 0], 5);

    expect(results.map((r) => r.id)).toEqual(["b"]);
  });

  it("isolates documents by namespace", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("ns1", [{ id: "a", text: "a", vector: [1, 0] }]);
    await store.upsert("ns2", [{ id: "b", text: "b", vector: [1, 0] }]);

    const results = await store.query("ns1", [1, 0], 5);

    expect(results.map((r) => r.id)).toEqual(["a"]);
  });
});
