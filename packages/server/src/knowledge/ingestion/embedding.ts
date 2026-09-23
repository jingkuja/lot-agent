import type { EmbeddingProvider } from "@lot-agent/core";
export class EmbeddingError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}
export interface TokenhubEmbeddingOptions {
  baseUrl: string; apiKey: string; model: string; dimensions: number;
  onUsage: (inputTokens: number, requestId?: string) => Promise<void>;
  fetcher?: typeof fetch;
}
export class TokenhubEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly options: TokenhubEmbeddingOptions) {
    if (!options.apiKey || !options.model || !Number.isInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 8192) throw new EmbeddingError("EMBEDDING_CONFIGURATION_REQUIRED");
  }
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!texts.length || texts.length > 20 || texts.some((text) => !text.trim() || text.length > 100000)) throw new EmbeddingError("EMBEDDING_INPUT_INVALID");
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model: this.options.model, input: texts, dimensions: this.options.dimensions, encoding_format: "float" }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      });
    } catch { throw new EmbeddingError("EMBEDDING_UNAVAILABLE", !signal?.aborted); }
    if (!response.ok) throw new EmbeddingError(response.status === 429 ? "EMBEDDING_RATE_LIMITED" : "EMBEDDING_REJECTED", response.status === 429 || response.status >= 500);
    const payload = await response.json().catch(() => null) as { usage?: { total_tokens?: number; prompt_tokens?: number }; data?: Array<{ index: number; embedding: number[] }> } | null;
    const tokens = payload?.usage?.total_tokens ?? payload?.usage?.prompt_tokens;
    if (!Number.isSafeInteger(tokens) || (tokens ?? 0) <= 0) throw new EmbeddingError("EMBEDDING_USAGE_MISSING");
    // A charged response remains billable even when vector validation fails.
    const requestId = response.headers.get("x-oneapi-request-id") ?? response.headers.get("x-request-id") ?? undefined;
    await this.options.onUsage(tokens!, requestId);
    if (!Array.isArray(payload?.data) || payload.data.length !== texts.length) throw new EmbeddingError("INVALID_EMBEDDING_RESPONSE");
    const result: number[][] = new Array(texts.length); const seen = new Set<number>();
    for (const entry of payload.data) {
      if (!entry || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= texts.length || seen.has(entry.index)
        || !Array.isArray(entry.embedding) || entry.embedding.length !== this.options.dimensions
        || entry.embedding.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new EmbeddingError("INVALID_EMBEDDING_RESPONSE");
      const norm = entry.embedding.reduce((sum, n) => sum + n * n, 0);
      if (!Number.isFinite(norm) || norm <= 0) throw new EmbeddingError("INVALID_EMBEDDING_RESPONSE");
      seen.add(entry.index); result[entry.index] = entry.embedding.map((value) => value / Math.sqrt(norm));
    }
    return result;
  }
}
