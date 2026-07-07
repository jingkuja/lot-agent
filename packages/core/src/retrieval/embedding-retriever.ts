import type { EmbeddingProvider } from "../providers/embedding.js";
import type { Retriever, VectorDoc, VectorStore } from "./types.js";

const DEFAULT_TOP_K = 5;

/**
 * Default {@link Retriever}: embeds text through an {@link EmbeddingProvider}
 * and delegates nearest-neighbour search to a {@link VectorStore}. `index`
 * is the write side (embed + upsert) so callers never touch raw vectors.
 */
export class EmbeddingRetriever implements Retriever {
  constructor(
    private readonly embedder: EmbeddingProvider,
    private readonly store: VectorStore
  ) {}

  /** Embed and upsert docs into a namespace. */
  async index(namespace: string, docs: VectorDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const vectors = await this.embedder.embed(docs.map((d) => d.text));
    await this.store.upsert(
      namespace,
      docs.map((d, i) => ({ ...d, vector: vectors[i] }))
    );
  }

  async retrieve(
    namespace: string,
    query: string,
    topK: number = DEFAULT_TOP_K
  ): Promise<VectorDoc[]> {
    const [vector] = await this.embedder.embed([query]);
    const hits = await this.store.query(namespace, vector, topK);
    // Strip the search-only `score` (and any stored vector) — the Retriever
    // contract yields plain VectorDocs.
    return hits.map(({ id, text, meta }) => ({ id, text, meta }));
  }
}
