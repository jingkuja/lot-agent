import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { ANALYSIS_LIMITS, type AnalysisSource } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";
import type { AnalysisStorage } from "./storage.js";

type Upload = { id: string; user_id: string; original_name: string; media_key: string; mime: string; size_bytes: number | string; source_hash: string; expired_at?: unknown };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const ANALYSIS_UPLOAD_MIMES = ["video/mp4", "video/quicktime", "video/webm"];

export async function ownedAnalysisUpload(db: Pick<pg.Pool, "query">, owner: string, id: string, lock = false): Promise<Upload> {
  const row = (await db.query(`SELECT * FROM marketing_analysis_uploads WHERE id=$1 AND user_id=$2${lock ? " FOR UPDATE" : ""}`, [id, owner])).rows[0];
  if (!row) throw new AnalysisError("UPLOAD_NOT_FOUND", 404);
  if (row.expired_at) throw new AnalysisError("UPLOAD_EXPIRED", 409);
  return row;
}

export function validateAnalysisUpload(bytes: Buffer, mime: string): string {
  if (!bytes.length || bytes.length > ANALYSIS_LIMITS.downloadBytes) throw new AnalysisError("UPLOAD_LIMIT", 413);
  const mp4 = bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
  const webm = bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
  if ((mp4 && ["video/mp4", "video/quicktime"].includes(mime)) || (webm && mime === "video/webm")) return mp4 ? "source.mp4" : "source.webm";
  throw new AnalysisError("UPLOAD_FORMAT");
}

/** Uploads stay in the same owner-scoped private storage as analysis evidence.
 * Decoding and the authoritative duration/pixel checks happen only in the
 * existing network-less Worker sandbox, never in the HTTP process. */
export async function storeAnalysisUpload(input: {
  pool: pg.Pool; storage: AnalysisStorage; owner: string; id: string; name: string; mime: string; bytes: Buffer; signal?: AbortSignal;
}) {
  if (!uuid.test(input.id)) throw new AnalysisError("INVALID_SOURCE");
  const mediaKey = validateAnalysisUpload(input.bytes, input.mime);
  const sourceHash = createHash("sha256").update(input.bytes).digest("hex");
  const name = input.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "video";
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
      return { id: input.id, name: prior.original_name as string };
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('media-analysis-storage',0))");
    const reserved = (await client.query(`SELECT count(*) AS global_count,count(*) FILTER(WHERE user_id=$1) AS owner_count
      FROM marketing_reference_analyses WHERE (status IN ('queued','running') OR lease_until>now()) AND deleted_at IS NULL`, [input.owner])).rows[0];
    await input.storage.assertCapacity(input.owner, Number(reserved.owner_count), Number(reserved.global_count));
    input.signal?.throwIfAborted();
    const directory = await input.storage.uploadDirectory(input.owner, input.id);
    await rm(join(directory, "upload.tmp"), { force: true });
    wrote = true;
    await writeFile(join(directory, "upload.tmp"), input.bytes, { flag: "wx", mode: 0o600, signal: input.signal });
    await rename(join(directory, "upload.tmp"), join(directory, mediaKey));
    input.signal?.throwIfAborted();
    await client.query(`INSERT INTO marketing_analysis_uploads(id,user_id,original_name,media_key,mime,size_bytes,source_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.id, input.owner, name, mediaKey, input.mime, input.bytes.length, sourceHash]);
    await client.query("COMMIT");
    return { id: input.id, name };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
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
    const bytes = await handle.readFile({ signal: input.signal });
    if (validateAnalysisUpload(bytes, upload.mime) !== upload.media_key || createHash("sha256").update(bytes).digest("hex") !== upload.source_hash) throw new AnalysisError("INVALID_PRIVATE_FILE");
    await writeFile(join(input.directory, upload.media_key), bytes, { flag: "wx", mode: 0o600, signal: input.signal });
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
