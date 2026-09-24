import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { KnowledgeKeyInputSchema, KnowledgeKeyUpdateSchema, type KnowledgeReadScope, type KnowledgePermission, type KnowledgeRetrievalRequest } from "@lot-agent/core";
import { KnowledgeRepository } from "../repository.js";
import { KnowledgeError } from "../errors.js";
import { resolveKnowledgeScope, type VerifiedKnowledgeCaller } from "../scope.js";
type Caller = Extract<VerifiedKnowledgeCaller, { kind: "access_key" }>;
const unauthorized = () => new KnowledgeError("UNAUTHORIZED", 401, "知识授权无效");
const missing = () => new KnowledgeError("NOT_FOUND", 404, "知识授权不存在或不可见");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const fields = "id,name,prefix,scopes,expires_at,revoked_at,version,created_at,last_used_at";
export class KnowledgeKeys {
  readonly repo: KnowledgeRepository;
  constructor(readonly pool: Pool) { this.repo = new KnowledgeRepository(pool); }
  async list(owner: string) {
    return (await this.pool.query(`SELECT ${fields},ARRAY(SELECT collection_id FROM rag_access_key_collections g WHERE g.owner_id=k.owner_id AND g.key_id=k.id ORDER BY collection_id) AS collection_ids FROM rag_access_keys k WHERE owner_id=$1 ORDER BY created_at DESC,id DESC`, [owner])).rows;
  }
  private async grants(client: PoolClient, owner: string, ids: string[]) {
    const owned = await client.query("SELECT id FROM rag_collections WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE", [owner, ids]);
    if (owned.rows.length !== ids.length) throw missing();
  }
  private expiry(value: string | null) { if (value && Date.parse(value) <= Date.now()) throw new KnowledgeError("INVALID_REQUEST", 400, "到期时间必须晚于当前时间"); }
  async create(owner: string, raw: unknown) {
    const input = KnowledgeKeyInputSchema.parse(raw); this.expiry(input.expiresAt);
    return this.repo.transaction(async (client) => {
      await this.grants(client, owner, input.collectionIds);
      const token = `lotk_${randomBytes(32).toString("base64url")}`;
      const row = (await client.query(`INSERT INTO rag_access_keys(owner_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${fields}`, [owner, input.name, hash(token), token.slice(0, 13), input.scopes, input.expiresAt])).rows[0];
      for (const id of input.collectionIds) await client.query("INSERT INTO rag_access_key_collections(owner_id,key_id,collection_id) VALUES($1,$2,$3)", [owner, row.id, id]);
      return { ...row, collection_ids: input.collectionIds, token };
    });
  }
  async update(owner: string, id: string, raw: unknown) {
    const input = KnowledgeKeyUpdateSchema.parse(raw); this.expiry(input.expiresAt);
    return this.repo.transaction(async (client) => {
      await this.grants(client, owner, input.collectionIds);
      const row = (await client.query(`UPDATE rag_access_keys SET name=$3,scopes=$4,expires_at=$5,version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$6 AND revoked_at IS NULL RETURNING ${fields}`, [owner, id, input.name, input.scopes, input.expiresAt, input.version])).rows[0];
      if (!row) throw new KnowledgeError("CONFLICT", 409, "授权已变化，请刷新后重试");
      await client.query("DELETE FROM rag_access_key_collections WHERE owner_id=$1 AND key_id=$2", [owner, id]);
      for (const collection of input.collectionIds) await client.query("INSERT INTO rag_access_key_collections(owner_id,key_id,collection_id) VALUES($1,$2,$3)", [owner, id, collection]);
      return { ...row, collection_ids: input.collectionIds };
    });
  }
  async revoke(owner: string, id: string, version: number) {
    const row = (await this.pool.query(`UPDATE rag_access_keys SET revoked_at=now(),version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$3 AND revoked_at IS NULL RETURNING ${fields}`, [owner, id, version])).rows[0];
    if (!row) throw new KnowledgeError("CONFLICT", 409, "授权已变化，请刷新后重试"); return row;
  }
  async rotate(owner: string, id: string, version: number) {
    const token = `lotk_${randomBytes(32).toString("base64url")}`;
    const row = (await this.pool.query(`UPDATE rag_access_keys SET token_hash=$4,prefix=$5,version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) RETURNING ${fields}`, [owner, id, version, hash(token), token.slice(0, 13)])).rows[0];
    if (!row) throw new KnowledgeError("CONFLICT", 409, "授权已变化，请刷新后重试"); return { ...row, token };
  }
  async authenticate(token: string): Promise<Caller & { version: number }> {
    if (!/^lotk_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
    const row = (await this.pool.query("SELECT id,owner_id,version FROM rag_access_keys WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())", [hash(token)])).rows[0];
    if (!row) throw unauthorized();
    return { ...await this.caller(row.owner_id, row.id, row.version), version: row.version };
  }
  async caller(owner: string, id: string, version?: number): Promise<Caller> {
    const row = (await this.pool.query(`SELECT k.*,ARRAY(SELECT collection_id FROM rag_access_key_collections g JOIN rag_collections c ON c.owner_id=g.owner_id AND c.id=g.collection_id WHERE g.owner_id=k.owner_id AND g.key_id=k.id AND c.deleted_at IS NULL ORDER BY collection_id) AS collection_ids
      FROM rag_access_keys k WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND ($3::int IS NULL OR version=$3)`, [owner, id, version ?? null])).rows[0];
    if (!row) throw unauthorized();
    return { kind: "access_key", userId: owner, keyId: id, application: row.name, scopes: row.scopes, collectionIds: row.collection_ids, expiresAt: row.expires_at?.toISOString() ?? null, revokedAt: null };
  }
  async scope(caller: Caller, ids: string[], permission: KnowledgePermission, version: number) {
    const fresh = await this.caller(caller.userId, caller.keyId, version);
    const scope = await resolveKnowledgeScope(fresh, ids, permission, (owner, values) => this.repo.findOwnedCollections(owner, values));
    return { ...scope, keyVersion: version };
  }
  async authorize(scope: KnowledgeReadScope, request?: KnowledgeRetrievalRequest) {
    if (scope.callerKind !== "access_key" || !scope.keyId || !scope.keyVersion) throw unauthorized();
    const caller = await this.caller(scope.ownerId, scope.keyId, scope.keyVersion);
    await resolveKnowledgeScope(caller, scope.collectionIds, scope.permission, (owner, ids) => this.repo.findOwnedCollections(owner, ids));
    if (request?.sourceTypes.includes("profile_fact") && !caller.scopes.includes("profile:read")) throw new KnowledgeError("SCOPE_FORBIDDEN", 403, "个人信息授权范围不足");
  }
  async touch(id: string) { await this.pool.query("UPDATE rag_access_keys SET last_used_at=now() WHERE id=$1", [id]); }
}
