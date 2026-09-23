import { createHash } from "node:crypto";
import type { Pool } from "pg";

export function lexicalText(text: string): string {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  // Preserve identifiers such as AB-123 independently of Chinese word boundaries.
  const identifiers = text.match(/[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+/g) ?? [];
  return [...Array.from(segmenter.segment(text.normalize("NFKC"))).filter((part) => part.isWordLike).map((part) => part.segment.toLowerCase()), ...identifiers.map((id) => id.toLowerCase())].join(" ");
}
export function indexProfile(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("INVALID_EMBEDDING_ROUTE");
  if (!process.versions.icu || Intl.Segmenter.supportedLocalesOf(["zh"]).length !== 1) throw new Error("CHINESE_SEGMENTER_UNAVAILABLE");
  const config = {
    modelId: "qwen3.7-text-embedding", providerRoute: baseUrl.replace(/\/$/, ""), dimensions: 1024,
    distance: "cosine", normalized: true, chunkerVersion: "utf8-budget-512-overlap64-v1", tokenizerVersion: "provider-usage-per-chunk-v1",
    dictionaryVersion: `intl-zh-icu-${process.versions.icu}-identifiers-v1`, maxTokens: 512,
  } as const;
  return { id: createHash("sha256").update(JSON.stringify(config)).digest("hex"), ...config };
}
export type IndexProfile = ReturnType<typeof indexProfile>;
export async function registerProfile(pool: Pool, profile: IndexProfile) {
  const { id, ...config } = profile;
  await pool.query("INSERT INTO rag_index_profiles(id,config) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING", [id, JSON.stringify(config)]);
}
