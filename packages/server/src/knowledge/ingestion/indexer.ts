import type { PoolClient } from "pg";
import type { KnowledgeJobs, IngestionLease } from "./jobs.js";
import type { ParsedArtifact } from "./parsers.js";
import { splitBlocks, type TextChunk } from "./text.js";
import { lexicalText, type IndexProfile, registerProfile } from "./profile.js";
import { spaceFor } from "./spaces.js";
export type EmbedOne = (text: string, signal?: AbortSignal) => Promise<{ vector: number[]; tokens: number }>;
export interface IndexedChunk extends TextChunk { vector: number[] }
const validVector = (vector: number[], dimensions: number) => vector.length === dimensions && vector.every(Number.isFinite) && vector.reduce((sum, n) => sum + n * n, 0) > 0 && Number.isFinite(vector.reduce((sum, n) => sum + n * n, 0));
/** Candidate byte budget, followed by actual provider usage validation. */
export async function embedArtifact(profile: IndexProfile, artifact: ParsedArtifact, embed: EmbedOne, prior: IndexedChunk[], checkpoint: (chunks: IndexedChunk[]) => Promise<void>, progress: (percentage: number) => Promise<void>, signal?: AbortSignal) {
  const candidates = splitBlocks(artifact.blocks, { count: (text) => Buffer.byteLength(text, "utf8") }, 512, 64, profile.chunkerVersion === "utf8-packed-512-overlap64-v2");
  if (candidates.length > 2000) throw new Error("TOO_MANY_CHUNKS");
  const chunks = [...prior];
  if (chunks.length > candidates.length || chunks.some((chunk, index) => chunk.text !== candidates[index].text || !validVector(chunk.vector, profile.dimensions) || chunk.tokenCount < 1 || chunk.tokenCount > 512)) throw new Error("INVALID_INDEX_CHECKPOINT");
  for (let n = chunks.length; n < candidates.length; n++) {
    if (signal?.aborted) throw new Error("INGESTION_CANCELLED");
    await progress(Math.floor(20 + 70 * n / candidates.length));
    const result = await embed(candidates[n].text, signal);
    if (!Number.isSafeInteger(result.tokens) || result.tokens < 1 || result.tokens > 512) throw new Error("EMBEDDING_TOKEN_BUDGET_EXCEEDED");
    if (!validVector(result.vector, profile.dimensions)) throw new Error("INVALID_EMBEDDING_RESPONSE");
    const norm = Math.sqrt(result.vector.reduce((sum, value) => sum + value * value, 0));
    chunks.push({ ...candidates[n], tokenCount: result.tokens, vector: result.vector.map((value) => value / norm) });
    await checkpoint(chunks);
  }
  return chunks;
}
export async function writeIndex(client: PoolClient, ids: { ownerId: string; itemId: string; revisionId: string }, profile: IndexProfile, chunks: IndexedChunk[]) {
  if (!chunks.length || chunks.some((chunk) => !validVector(chunk.vector, profile.dimensions))) throw new Error("INCOMPLETE_INDEX");
  const table = await spaceFor(client, profile);
  await client.query(`DELETE FROM ${table} WHERE owner_id=$1 AND revision_id=$2 AND profile_id=$3`, [ids.ownerId, ids.revisionId, profile.id]);
  for (const [ordinal, chunk] of chunks.entries()) {
    await client.query(`INSERT INTO ${table}(owner_id,item_id,revision_id,profile_id,ordinal,content,origin,citation,input_tokens,overlap_characters,lexical,embedding)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_tsvector('simple',$11),$12::public.vector)`,
    [ids.ownerId, ids.itemId, ids.revisionId, profile.id, ordinal, chunk.text, chunk.origin, chunk.citation ? JSON.stringify(chunk.citation) : null,
      chunk.tokenCount, chunk.overlapCharacters, lexicalText(chunk.text), JSON.stringify(chunk.vector)]);
  }
  await client.query(`INSERT INTO rag_revision_indexes(owner_id,item_id,revision_id,profile_id,chunk_count) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(owner_id,revision_id,profile_id) DO UPDATE SET chunk_count=EXCLUDED.chunk_count,completed_at=now()`, [ids.ownerId, ids.itemId, ids.revisionId, profile.id, chunks.length]);
}
export async function indexArtifact(jobs: KnowledgeJobs, lease: IngestionLease, profile: IndexProfile, artifact: ParsedArtifact, embed: EmbedOne, signal?: AbortSignal) {
  await registerProfile(jobs.pool, profile);
  const version = `index-v1-${profile.id}`;
  const prior = await jobs.readCheckpoint(lease, version) as { parser: ParsedArtifact; chunks: IndexedChunk[] } | null;
  const chunks = await embedArtifact(profile, artifact, embed, prior?.chunks ?? [], async (chunks) => {
    if (!await jobs.checkpoint(lease, version, { parser: artifact, chunks })) throw new Error("INGESTION_CANCELLED");
  }, async (progress) => { if (!await jobs.heartbeat(lease, "embedding", progress)) throw new Error("INGESTION_CANCELLED"); }, signal);
  return jobs.publish(lease, async (client) => {
    await client.query("INSERT INTO rag_user_index_state(owner_id,active_profile_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [lease.ownerId, profile.id]);
    const state = (await client.query("SELECT active_profile_id FROM rag_user_index_state WHERE owner_id=$1 FOR UPDATE", [lease.ownerId])).rows[0];
    if (state.active_profile_id !== profile.id) throw new Error("INDEX_PROFILE_CHANGED");
    await writeIndex(client, lease, profile, chunks);
    await client.query("UPDATE rag_item_revisions SET index_profile_id=$4,diagnostics=$5 WHERE owner_id=$1 AND item_id=$2 AND id=$3", [lease.ownerId, lease.itemId, lease.revisionId, profile.id, JSON.stringify({ warnings: artifact.diagnostics })]);
  });
}
