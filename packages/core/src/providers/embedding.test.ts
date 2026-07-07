import { describe, it, expect } from "vitest";
import { StubEmbeddingProvider } from "./embedding.js";

describe("StubEmbeddingProvider", () => {
  it("returns one vector per input text", async () => {
    const p = new StubEmbeddingProvider(8);
    const vecs = await p.embed(["a", "b", "c"]);
    expect(vecs).toHaveLength(3);
    expect(vecs.every((v) => v.length === 8)).toBe(true);
  });

  it("is deterministic — same text yields the same vector", async () => {
    const p = new StubEmbeddingProvider();
    const [v1] = await p.embed(["hello world"]);
    const [v2] = await p.embed(["hello world"]);
    expect(v2).toEqual(v1);
  });

  it("distinguishes different texts", async () => {
    const p = new StubEmbeddingProvider();
    const [a, b] = await p.embed(["cat", "dog"]);
    expect(a).not.toEqual(b);
  });

  it("returns an empty array for no inputs", async () => {
    const p = new StubEmbeddingProvider();
    expect(await p.embed([])).toEqual([]);
  });
});
