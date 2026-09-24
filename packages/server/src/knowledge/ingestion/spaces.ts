import type { Pool, PoolClient } from "pg";
import type { IndexProfile } from "./profile.js";
export function indexTable(name: string): string {
  if (name !== "rag_chunks" && !/^rag_vectors_[a-f0-9]{24}$/.test(name)) throw new Error("INVALID_INDEX_SPACE");
  return `"${name}"`;
}
export async function spaceFor(db: Pool | PoolClient, profile: IndexProfile) {
  const row = (await db.query("SELECT table_name,dimensions FROM rag_index_spaces WHERE profile_id=$1", [profile.id])).rows[0];
  if (!row && profile.dimensions === 1024) return indexTable("rag_chunks");
  if (!row || row.dimensions !== profile.dimensions) throw new Error("INDEX_SPACE_REQUIRED");
  return indexTable(row.table_name);
}
export async function activeProfile(pool: Pool, owner: string, fallback: IndexProfile): Promise<IndexProfile> {
  const row = (await pool.query("SELECT p.id,p.config FROM rag_user_index_state u JOIN rag_index_profiles p ON p.id=u.active_profile_id WHERE u.owner_id=$1", [owner])).rows[0];
  return row ? { id: row.id, ...row.config } as IndexProfile : fallback;
}
/** Administrator-only DDL. Regular requests never resize a vector column. */
export async function createIndexSpace(pool: Pool, profile: IndexProfile) {
  if (!/^[a-f0-9]{64}$/.test(profile.id) || !Number.isInteger(profile.dimensions) || profile.dimensions < 1 || profile.dimensions > 8192) throw new Error("INVALID_INDEX_PROFILE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`space:${profile.id}`]);
    const { id, ...config } = profile;
    await client.query("INSERT INTO rag_index_profiles(id,config) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, JSON.stringify(config)]);
    if ((await client.query("SELECT 1 FROM rag_index_spaces WHERE profile_id=$1", [id])).rows.length) { await client.query("COMMIT"); return spaceFor(pool, profile); }
    const name = `rag_vectors_${id.slice(0, 24)}`; const table = indexTable(name);
    await client.query(`CREATE TABLE ${table} (LIKE rag_chunks INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    await client.query(`ALTER TABLE ${table} ALTER COLUMN embedding TYPE public.vector(${profile.dimensions})`);
    await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY(id), ADD UNIQUE(owner_id,revision_id,profile_id,ordinal),
      ADD FOREIGN KEY(owner_id,item_id,revision_id) REFERENCES rag_item_revisions(owner_id,item_id,id) ON DELETE CASCADE,
      ADD FOREIGN KEY(profile_id) REFERENCES rag_index_profiles(id)`);
    await client.query(`CREATE INDEX ON ${table}(owner_id,revision_id,profile_id)`);
    await client.query(`CREATE INDEX ON ${table} USING gin(lexical)`);
    await client.query("INSERT INTO rag_index_spaces(profile_id,table_name,dimensions) VALUES($1,$2,$3)", [id, name, profile.dimensions]);
    await client.query("COMMIT"); return table;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
