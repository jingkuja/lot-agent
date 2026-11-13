import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRepoEnv } from "../env-file.js";
import { imageAssetRoles } from "../db/migrations/0083-image-asset-roles.js";
import { KnowledgeMaterials } from "./materials.js";

describe.skipIf(process.env.IMAGE_PG_TEST !== "1")("image material versions on local PostgreSQL", () => {
  const schema = `image_materials_test_${randomUUID().replaceAll("-", "")}`;
  const owner = randomUUID(), other = randomUUID(), conversation = randomUUID();
  let pool: pg.Pool;
  let materials: KnowledgeMaterials;
  let created = false;
  const url = (key: string) => `/static/assets/${key}.png`;
  const metadata = (output: string, background = "background") => ({
    kind: "generation", mediaType: "image", assets: [{ url: url(output) }], posters: [{ background: { url: url(background) } }],
  });
  const asset = async (key: string, user = owner, purpose = "output") => {
    const id = randomUUID();
    await pool.query(`INSERT INTO assets(id,user_id,type,mime,storage_key,url,material_purpose)
      VALUES($1,$2,'image','image/png',$3,$4,$5)`, [id, user, `${key}.png`, url(key), purpose]);
    return id;
  };
  const message = async (output: string, background?: string) => {
    const id = randomUUID();
    await pool.query("INSERT INTO messages VALUES($1,$2,$3)", [id, conversation, metadata(output, background)]);
    return id;
  };
  beforeAll(async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, VITEST: undefined };
    loadRepoEnv({ env });
    const host = env.PG_HOST ?? "localhost";
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Local PostgreSQL required");
    pool = new pg.Pool({ host, port: Number(env.PG_PORT) || 5432, user: env.PG_USER ?? "postgres", password: env.PG_PASSWORD,
      database: env.PG_DATABASE ?? "lot", options: `-c search_path=${schema}`, connectionTimeoutMillis: 3000 });
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    await pool.query(`CREATE TABLE conversations(id UUID PRIMARY KEY,user_id TEXT,agent_id TEXT);
      CREATE TABLE messages(id UUID PRIMARY KEY,conversation_id UUID REFERENCES conversations(id),metadata JSONB);
      CREATE TABLE tasks(id UUID PRIMARY KEY,input JSONB);
      CREATE TABLE assets(id UUID PRIMARY KEY,user_id TEXT,type TEXT,mime TEXT,storage_key TEXT,url TEXT,task_id UUID,
        original_name TEXT,size_bytes INTEGER,width INTEGER,height INTEGER,duration_sec NUMERIC,share_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE rag_items(id UUID,owner_id UUID,source_asset_id UUID,deleted_at TIMESTAMPTZ);
      CREATE TABLE rag_item_tags(owner_id UUID,item_id UUID,tag TEXT);
      CREATE TABLE de_marketing_asset_library(task_id UUID)`);
    await pool.query("INSERT INTO conversations VALUES($1,$2,'image')", [conversation, owner]);
    await pool.query(`INSERT INTO assets(id,user_id,type,mime,storage_key,url) VALUES
      ($1,$3,'image','image/png','background.png',$4),($2,$3,'image','image/png','legacy.png',$5)`,
    [randomUUID(), randomUUID(), owner, url("background"), url("legacy")]);
    await pool.query("INSERT INTO messages VALUES($1,$2,$3)", [randomUUID(), conversation, metadata("legacy")]);
    await imageAssetRoles.up(pool);
    materials = new KnowledgeMaterials({ pool } as any, {} as any, "/tmp");
  });
  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  it("backfills only proven backgrounds, remains idempotent, and preserves a failed render used as output", async () => {
    expect((await materials.list(owner)).map(row => row.url)).toEqual([url("legacy")]);
    await imageAssetRoles.up(pool);
    expect((await materials.list(owner)).map(row => row.url)).toEqual([url("legacy")]);
    await message("background");
    expect((await materials.list(owner)).map(row => row.url)).toContain(url("background"));
    await asset("uncertain-history");
    expect((await materials.list(owner)).map(row => row.url)).toContain(url("uncertain-history"));
  });

  it("keeps a shared current version visible across edits, then hides it before pagination", async () => {
    const original = await asset("shared");
    const first = await message("shared"), second = await message("shared");
    await asset("edit-one", owner, "version"); await asset("edit-two", owner, "version");
    await pool.query("UPDATE messages SET metadata=$1 WHERE id=$2", [metadata("edit-one"), first]);
    expect((await materials.list(owner)).map(row => row.id)).toContain(original);
    await pool.query("UPDATE messages SET metadata=$1 WHERE id=$2", [metadata("edit-two"), second]);
    const visible = await materials.list(owner);
    expect(visible.map(row => row.id)).not.toContain(original);
    expect(visible.map(row => row.url)).toEqual(expect.arrayContaining([url("edit-one"), url("edit-two")]));
    const firstPage = await materials.list(owner, 1);
    const nextPage = await materials.list(owner, 1, firstPage[0].cursor_time, firstPage[0].id);
    expect(firstPage).toHaveLength(1); expect(nextPage).toHaveLength(1);
    expect(firstPage[0].id).not.toBe(nextPage[0].id);
    await pool.query("UPDATE assets SET share_token='existing-share' WHERE id=$1", [original]);
    expect((await materials.list(owner)).map(row => row.id)).toContain(original);
    await pool.query("UPDATE assets SET share_token=NULL WHERE id=$1", [original]);
    await pool.query("INSERT INTO rag_items VALUES($1,$2,$3,NULL)", [randomUUID(), owner, original]);
    expect((await materials.list(owner, 30, undefined, undefined, { source: "archived" })).map(row => row.id)).toEqual([original]);
  });

  it("serializes concurrent edits and rejects cross-user references and deletion of live backgrounds", async () => {
    const bg = await asset("protected-bg", owner, "dependency");
    const id = await message("protected-bg", "protected-bg");
    await Promise.all(["parallel-one", "parallel-two"].map(async key => {
      await asset(key, owner, "version");
      await pool.query("UPDATE messages SET metadata=$1 WHERE id=$2", [metadata(key, "protected-bg"), id]);
    }));
    const refs = (await pool.query("SELECT a.url FROM generation_asset_references r JOIN assets a ON a.id=r.asset_id WHERE message_id=$1 AND role='output'",
      [id])).rows;
    expect(refs).toHaveLength(1);
    const current = (await pool.query("SELECT metadata FROM messages WHERE id=$1", [id])).rows[0].metadata.assets[0].url;
    expect(refs[0].url).toBe(current);
    await expect(materials.remove(owner, bg)).rejects.toMatchObject({ status: 409 });
    const foreign = await asset("foreign", other);
    const forged = await message("foreign", "foreign");
    expect((await pool.query("SELECT * FROM generation_asset_references WHERE message_id=$1", [forged])).rows).toEqual([]);
    expect((await materials.list(owner)).map(row => row.id)).not.toContain(foreign);
    await expect(materials.remove(other, bg)).rejects.toMatchObject({ status: 404 });
  });
});
