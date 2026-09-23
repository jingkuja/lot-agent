import type { KnowledgeJobs, IngestionLease } from "./jobs.js";
import type { ParsedArtifact } from "./parsers.js";
import { splitBlocks, type TextChunk } from "./text.js";
import { lexicalText, type IndexProfile, registerProfile } from "./profile.js";

export type EmbedOne = (text: string, signal?: AbortSignal) => Promise<{ vector: number[]; tokens: number }>;
interface IndexedChunk extends TextChunk { vector: number[] }
const validVector = (vector: number[]) => vector.length === 1024 && vector.every(Number.isFinite) && vector.reduce((sum, n) => sum + n * n, 0) > 0 && Number.isFinite(vector.reduce((sum, n) => sum + n * n, 0));
/** Byte-budget candidates, with REAL per-input provider usage checked before publication.
 * This deliberately does not claim to be the model's unpublished local tokenizer.
 */
export async function indexArtifact(jobs: KnowledgeJobs, lease: IngestionLease, profile: IndexProfile, artifact: ParsedArtifact, embed: EmbedOne, signal?: AbortSignal) {
  await registerProfile(jobs.pool, profile);
  const checkpointVersion = `index-v1-${profile.id}`;
  const prior = await jobs.readCheckpoint(lease, checkpointVersion) as { parser: ParsedArtifact; chunks: IndexedChunk[] } | null;
  const candidates = splitBlocks(artifact.blocks, { count: (text) => Buffer.byteLength(text, "utf8") }, 512, 64);
  if (candidates.length > 2000) throw new Error("TOO_MANY_CHUNKS");
  const chunks: IndexedChunk[] = prior?.chunks ?? [];
  if (chunks.length > candidates.length || chunks.some((chunk, index) => chunk.text !== candidates[index].text || !validVector(chunk.vector) || chunk.tokenCount < 1 || chunk.tokenCount > 512)) throw new Error("INVALID_INDEX_CHECKPOINT");
  for (let n = chunks.length; n < candidates.length; n++) {
    if (signal?.aborted || !await jobs.heartbeat(lease, "embedding", Math.floor(20 + 70 * n / candidates.length))) throw new Error("INGESTION_CANCELLED");
    const result = await embed(candidates[n].text, signal);
    if (!Number.isSafeInteger(result.tokens) || result.tokens < 1 || result.tokens > 512) throw new Error("EMBEDDING_TOKEN_BUDGET_EXCEEDED");
    if (!validVector(result.vector)) throw new Error("INVALID_EMBEDDING_RESPONSE");
    const norm = Math.sqrt(result.vector.reduce((sum, value) => sum + value * value, 0));
    chunks.push({ ...candidates[n], tokenCount: result.tokens, vector: result.vector.map((value) => value / norm) });
    if (!await jobs.checkpoint(lease, checkpointVersion, { parser: artifact, chunks })) throw new Error("INGESTION_CANCELLED");
  }
  return jobs.publish(lease, async (client) => {
    if (!chunks.length || chunks.length !== candidates.length) throw new Error("INCOMPLETE_INDEX");
    await client.query("DELETE FROM rag_chunks WHERE owner_id=$1 AND revision_id=$2", [lease.ownerId, lease.revisionId]);
    for (const [ordinal, chunk] of chunks.entries()) {
      await client.query(`INSERT INTO rag_chunks(owner_id,item_id,revision_id,profile_id,ordinal,content,origin,citation,input_tokens,overlap_characters,lexical,embedding)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_tsvector('simple',$11),$12::public.vector)`,
      [lease.ownerId, lease.itemId, lease.revisionId, profile.id, ordinal, chunk.text, chunk.origin, chunk.citation ? JSON.stringify(chunk.citation) : null,
        chunk.tokenCount, chunk.overlapCharacters, lexicalText(chunk.text), JSON.stringify(chunk.vector)]);
    }
    await client.query("UPDATE rag_item_revisions SET index_profile_id=$4,diagnostics=$5 WHERE owner_id=$1 AND item_id=$2 AND id=$3", [lease.ownerId, lease.itemId, lease.revisionId, profile.id, JSON.stringify({ warnings: artifact.diagnostics })]);
  });
}
