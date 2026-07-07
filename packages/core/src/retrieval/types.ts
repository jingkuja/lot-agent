/**
 * Retrieval base (E4): the abstractions that turn the reserved
 * `TokenBudget.retrieval` channel into a real pipe. Interfaces live in core;
 * a real vector backend (pgvector) is an impl-in-server concern.
 */

/** A retrievable document: opaque id + raw text + optional metadata. */
export interface VectorDoc {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
}

/**
 * Vector index keyed by namespace (e.g. `user:{id}:notes`). Callers own the
 * embedding — `upsert`/`query` take vectors, so the store stays model-agnostic.
 */
export interface VectorStore {
  /** Insert or replace docs (by id) in a namespace. */
  upsert(
    namespace: string,
    docs: Array<VectorDoc & { vector: number[] }>
  ): Promise<void>;
  /** Nearest `topK` docs to `vector` in a namespace, most-similar first. */
  query(
    namespace: string,
    vector: number[],
    topK: number
  ): Promise<Array<VectorDoc & { score: number }>>;
  /** Remove docs by id from a namespace. */
  delete(namespace: string, ids: string[]): Promise<void>;
}

/** Embedding + VectorStore facade: text query in, ranked docs out. */
export interface Retriever {
  retrieve(namespace: string, query: string, topK?: number): Promise<VectorDoc[]>;
}
