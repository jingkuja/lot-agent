import type { VectorDoc, VectorStore } from "./types.js";

interface StoredDoc extends VectorDoc {
  vector: number[];
}

/**
 * In-process vector store with cosine-similarity search. For dev/unit use and
 * as the contract baseline for real adapters (pgvector) — no persistence, no
 * approximate index, just a linear scan per namespace.
 */
export class InMemoryVectorStore implements VectorStore {
  private namespaces = new Map<string, Map<string, StoredDoc>>();

  async upsert(
    namespace: string,
    docs: Array<VectorDoc & { vector: number[] }>
  ): Promise<void> {
    const ns = this.nsMap(namespace);
    for (const doc of docs) {
      ns.set(doc.id, { id: doc.id, text: doc.text, meta: doc.meta, vector: doc.vector });
    }
  }

  async query(
    namespace: string,
    vector: number[],
    topK: number
  ): Promise<Array<VectorDoc & { score: number }>> {
    const ns = this.namespaces.get(namespace);
    if (!ns) return [];
    return [...ns.values()]
      .map((doc) => ({
        id: doc.id,
        text: doc.text,
        meta: doc.meta,
        score: cosine(vector, doc.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, topK));
  }

  async delete(namespace: string, ids: string[]): Promise<void> {
    const ns = this.namespaces.get(namespace);
    if (!ns) return;
    for (const id of ids) ns.delete(id);
  }

  private nsMap(namespace: string): Map<string, StoredDoc> {
    let ns = this.namespaces.get(namespace);
    if (!ns) {
      ns = new Map();
      this.namespaces.set(namespace, ns);
    }
    return ns;
  }
}

/** Cosine similarity; 0 when either vector is zero-length or lengths differ. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
