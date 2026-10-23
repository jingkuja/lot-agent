import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { link, open, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import type pg from "pg";
import { ANALYSIS_LIMITS, ANALYSIS_UPLOAD_MIMES, type AnalysisSource } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";
import type { AnalysisStorage } from "./storage.js";
import { meteredUpload, UploadTooLargeError } from "../util/metered-upload.js";

type Upload = { id: string; user_id: string; original_name: string; media_key: string; mime: string; size_bytes: number | string; source_hash: string; expired_at?: unknown };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function ownedAnalysisUpload(db: Pick<pg.Pool, "query">, owner: string, id: string, lock = false): Promise<Upload> {
  const row = (await db.query(`SELECT * FROM marketing_analysis_uploads WHERE id=$1 AND user_id=$2${lock ? " FOR UPDATE" : ""}`, [id, owner])).rows[0];
  if (!row) throw new AnalysisError("UPLOAD_NOT_FOUND", 404);
  if (row.expired_at) throw new AnalysisError("UPLOAD_EXPIRED", 409);
  return row;
}

/** The stored name of an upload from its first bytes, size and declared type. */
export function analysisMediaKey(head: Buffer, size: number, mime: string): string {
  if (!size || size > ANALYSIS_LIMITS.downloadBytes) throw new AnalysisError("UPLOAD_LIMIT", 413);
  const mp4 = head.length >= 12 && head.toString("ascii", 4, 8) === "ftyp";
  const webm = head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
  if ((mp4 && ["video/mp4", "video/quicktime"].includes(mime)) || (webm && mime === "video/webm")) return mp4 ? "source.mp4" : "source.webm";
  throw new AnalysisError("UPLOAD_FORMAT");
}
export const validateAnalysisUpload = (bytes: Buffer, mime: string) => analysisMediaKey(bytes.subarray(0, 16), bytes.length, mime);

async function assertUploadCapacity(db: Pick<pg.Pool, "query">, storage: AnalysisStorage, owner: string) {
  const reserved = (await db.query(`SELECT count(*) AS global_count,count(*) FILTER(WHERE user_id=$1) AS owner_count
    FROM marketing_reference_analyses WHERE (status IN ('queued','running') OR lease_until>now()) AND deleted_at IS NULL`, [owner])).rows[0];
  await storage.assertCapacity(owner, Number(reserved.owner_count), Number(reserved.global_count));
}

/** Uploads stay in the same owner-scoped private storage as analysis evidence.
 * Decoding and the authoritative duration/pixel checks happen only in the
 * existing network-less Worker sandbox, never in the HTTP process. The body is
 * streamed to a staged file beside the final one (up to 100 MB, never held in
 * memory), checked and hashed as it arrives, then moved into place. */
export async function storeAnalysisUpload(input: {
  pool: pg.Pool; storage: AnalysisStorage; owner: string; id: string; name: string; mime: string;
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>; signal?: AbortSignal;
}) {
  if (!uuid.test(input.id)) throw new AnalysisError("INVALID_SOURCE");
  if (!ANALYSIS_UPLOAD_MIMES.includes(input.mime)) throw new AnalysisError("UPLOAD_FORMAT");
  const name = input.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "video";
  // Early refusal before any bytes are written, checked again under the lock below. A retry
  // of a stored upload is not refused: it only has to match what was stored.
  const known = (await input.pool.query("SELECT id FROM marketing_analysis_uploads WHERE id=$1", [input.id])).rowCount;
  if (!known) await assertUploadCapacity(input.pool, input.storage, input.owner);
  const directory = await input.storage.uploadDirectory(input.owner, input.id);
  // A unique name: a retried request may stream at the same time as the first one.
  const staged = join(directory, `upload-${randomUUID()}.tmp`);
  const upload = meteredUpload(input.body, ANALYSIS_LIMITS.downloadBytes);
  let mediaKey: string;
  try {
    await pipeline(upload.stream, createWriteStream(staged, { flags: "wx", mode: 0o600 }), { signal: input.signal });
    mediaKey = analysisMediaKey(upload.state.head, upload.state.size, input.mime);
  } catch (error) {
    await rm(staged, { force: true });
    if (error instanceof UploadTooLargeError) throw new AnalysisError("UPLOAD_LIMIT", 413);
    throw error;
  }
  const sourceHash = upload.state.sha256;
  const client = await input.pool.connect();
  let wrote = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`media-analysis-budget:${input.owner}`]);
    const prior = (await client.query("SELECT * FROM marketing_analysis_uploads WHERE id=$1", [input.id])).rows[0];
    if (prior) {
      if (prior.user_id !== input.owner || prior.source_hash !== sourceHash || prior.mime !== input.mime) throw new AnalysisError("REQUEST_CONFLICT", 409);
      if (prior.expired_at) throw new AnalysisError("UPLOAD_EXPIRED", 409);
      await client.query("COMMIT");
      await rm(staged, { force: true });
      return { id: input.id, name: prior.original_name as string };
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('media-analysis-storage',0))");
    await assertUploadCapacity(client, input.storage, input.owner);
    input.signal?.throwIfAborted();
    wrote = true;
    await rename(staged, join(directory, mediaKey));
    input.signal?.throwIfAborted();
    await client.query(`INSERT INTO marketing_analysis_uploads(id,user_id,original_name,media_key,mime,size_bytes,source_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.id, input.owner, name, mediaKey, input.mime, upload.state.size, sourceHash]);
    await client.query("COMMIT");
    return { id: input.id, name };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await rm(staged, { force: true });
    // A lost COMMIT acknowledgement may still have persisted the upload. Only
    // remove bytes after a separate successful read proves there is no row.
    if (wrote) {
      const saved = await input.pool.query("SELECT id FROM marketing_analysis_uploads WHERE id=$1 AND user_id=$2", [input.id, input.owner]).catch(() => null);
      if (saved && !saved.rowCount) await input.storage.removeUpload(input.owner, input.id);
    }
    throw error;
  } finally { client.release(); }
}

export async function copyAnalysisUpload(input: {
  pool: Pick<pg.Pool, "query">; storage: AnalysisStorage; owner: string; source: AnalysisSource; directory: string; signal?: AbortSignal;
}): Promise<AnalysisSource> {
  const upload = await ownedAnalysisUpload(input.pool, input.owner, input.source.uploadId ?? "");
  if (!/^source\.(mp4|webm)$/.test(upload.media_key) || upload.source_hash !== input.source.sourceHash) throw new AnalysisError("INVALID_PRIVATE_FILE");
  input.signal?.throwIfAborted();
  const directory = await input.storage.uploadDirectory(input.owner, upload.id);
  let handle;
  try { handle = await open(join(directory, upload.media_key), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AnalysisError("UPLOAD_EXPIRED", 409); throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== Number(upload.size_bytes) || stat.size > ANALYSIS_LIMITS.downloadBytes) throw new AnalysisError("INVALID_PRIVATE_FILE");
    // Streamed and hashed into a staged file; only a copy that matches the recorded upload is
    // linked into place, and an existing file there is never replaced.
    const staged = join(input.directory, `${upload.media_key}.${randomUUID()}.part`);
    const copy = meteredUpload(handle.createReadStream({ autoClose: false }), ANALYSIS_LIMITS.downloadBytes);
    try {
      await pipeline(copy.stream, createWriteStream(staged, { flags: "wx", mode: 0o600 }), { signal: input.signal });
      if (analysisMediaKey(copy.state.head, copy.state.size, upload.mime) !== upload.media_key || copy.state.sha256 !== upload.source_hash) throw new AnalysisError("INVALID_PRIVATE_FILE");
      await link(staged, join(input.directory, upload.media_key));
    } catch (error) {
      if (error instanceof UploadTooLargeError || error instanceof AnalysisError) throw new AnalysisError("INVALID_PRIVATE_FILE");
      throw error;
    } finally { await rm(staged, { force: true }); }
    return { ...input.source, mediaKey: upload.media_key, title: upload.original_name };
  } finally { await handle.close(); }
}

export async function collectAnalysisUploads(client: Pick<pg.PoolClient, "query">, storage: AnalysisStorage) {
  const rows = (await client.query(`SELECT * FROM marketing_analysis_uploads u WHERE expired_at IS NULL AND created_at<now()-interval '7 days'
    AND NOT EXISTS(SELECT 1 FROM marketing_reference_analyses a WHERE a.user_id=u.user_id AND a.snapshot->'source'->>'uploadId'=u.id::text
      AND a.deleted_at IS NULL AND (a.status IN ('queued','running') OR a.lease_until>now()))
    ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
  for (const row of rows) {
    await storage.removeUpload(row.user_id, row.id);
    await client.query("UPDATE marketing_analysis_uploads SET expired_at=now() WHERE id=$1", [row.id]);
  }
}
