import type { Migration } from "../migration-runner.js";
export const knowledgeAccess: Migration = {
  version: 29, name: "knowledge-access",
  async up(client) {
    await client.query(`CREATE TABLE rag_access_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{retrieval:read}', expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
      version INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ,
      UNIQUE(owner_id,id), CHECK(scopes <@ ARRAY['retrieval:read','profile:read','assets:read']::text[] AND cardinality(scopes)>0)
    );
    CREATE INDEX rag_access_keys_owner ON rag_access_keys(owner_id,created_at DESC,id DESC);
    CREATE TABLE rag_access_key_collections (
      owner_id UUID NOT NULL, key_id UUID NOT NULL, collection_id UUID NOT NULL,
      PRIMARY KEY(owner_id,key_id,collection_id),
      FOREIGN KEY(owner_id,key_id) REFERENCES rag_access_keys(owner_id,id) ON DELETE CASCADE,
      FOREIGN KEY(owner_id,collection_id) REFERENCES rag_collections(owner_id,id) ON DELETE CASCADE
    );
    ALTER TABLE rag_embedding_charges ADD COLUMN knowledge_key_id UUID REFERENCES rag_access_keys(id) ON DELETE SET NULL;
    ALTER TABLE rag_embedding_charges ADD COLUMN application TEXT;
    ALTER TABLE usage_logs ADD COLUMN knowledge_key_id UUID REFERENCES rag_access_keys(id) ON DELETE SET NULL;
    ALTER TABLE usage_logs ADD COLUMN application TEXT;
    ALTER TABLE conversations ADD COLUMN knowledge_source TEXT NOT NULL DEFAULT 'remote' CHECK(knowledge_source IN ('remote','local'));
    CREATE TABLE rag_legacy_collection_mappings (
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, legacy_id TEXT NOT NULL, collection_id UUID NOT NULL,
      PRIMARY KEY(owner_id,legacy_id), FOREIGN KEY(owner_id,collection_id) REFERENCES rag_collections(owner_id,id) ON DELETE CASCADE
    );`);
  },
};
