/**
 * Text embedding provider — the geometric substrate for E4's retrieval base
 * (`VectorStore` / `Retriever`). Real impls (tokenhub / bge / text-embedding-*)
 * live behind this interface; the stub is deterministic so dev/unit cosine
 * similarity is reproducible without a network call.
 */
export interface EmbeddingProvider {
  /** Embed a batch of texts; result[i] corresponds to texts[i]. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic hash-based pseudo-embedding (no model, no network). Same text →
 * same unit vector; different texts → different vectors. Good enough for wiring
 * and cosine-similarity tests, not for real semantic retrieval.
 */
export class StubEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dim: number = 8) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vec(t));
  }

  private vec(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      // Scatter each char into a bucket with a per-position weight — cheap,
      // deterministic, and text-sensitive.
      const code = text.charCodeAt(i);
      v[code % this.dim] += ((code * (i + 1)) % 97) / 97;
    }
    // L2-normalize so cosine similarity is a plain dot product.
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
