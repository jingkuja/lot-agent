import { describe, it, expect } from "vitest";
import { EmbeddingRetriever } from "./embedding-retriever.js";
import { InMemoryVectorStore } from "./in-memory-vector-store.js";
import { StubEmbeddingProvider } from "../providers/embedding.js";

function build() {
  return new EmbeddingRetriever(new StubEmbeddingProvider(32), new InMemoryVectorStore());
}

describe("EmbeddingRetriever", () => {
  it("indexes docs then retrieves the closest match for a query", async () => {
    const retriever = build();
    await retriever.index("ns", [
      { id: "1", text: "how to bake sourdough bread" },
      { id: "2", text: "quantum physics for beginners" },
    ]);

    const docs = await retriever.retrieve("ns", "how to bake sourdough bread", 1);

    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe("1");
    expect(docs[0].text).toBe("how to bake sourdough bread");
  });

  it("returns plain VectorDocs without leaking the similarity score or vector", async () => {
    const retriever = build();
    await retriever.index("ns", [{ id: "1", text: "hello", meta: { src: "note" } }]);

    const [doc] = await retriever.retrieve("ns", "hello", 5);

    expect(doc).not.toHaveProperty("score");
    expect(doc).not.toHaveProperty("vector");
    expect(doc.meta).toEqual({ src: "note" });
  });

  it("returns nothing for an empty namespace", async () => {
    const retriever = build();
    const docs = await retriever.retrieve("empty", "anything");
    expect(docs).toEqual([]);
  });
});
