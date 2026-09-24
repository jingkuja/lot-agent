import type { Migration } from "../migration-runner.js";
export const knowledgeManagementCompletion: Migration = {
  version: 27, name: "knowledge-management-completion",
  async up(client) {
    await client.query(`
      ALTER TABLE rag_collections ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE rag_items ADD COLUMN source_asset_id UUID;
      CREATE UNIQUE INDEX rag_items_source_asset ON rag_items(owner_id,source_asset_id) WHERE deleted_at IS NULL AND source_asset_id IS NOT NULL;
      CREATE TABLE rag_profile_facts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value JSONB NOT NULL, value_type TEXT NOT NULL CHECK(value_type IN ('text','number','boolean','list')),
        category TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', active BOOLEAN NOT NULL DEFAULT true,
        valid_from TIMESTAMPTZ, valid_until TIMESTAMPTZ, share_with_api BOOLEAN NOT NULL DEFAULT false,
        version INT NOT NULL DEFAULT 1 CHECK(version>0), item_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(owner_id,key), UNIQUE(owner_id,id), UNIQUE(owner_id,item_id),
        CHECK(valid_until IS NULL OR valid_from IS NULL OR valid_until>valid_from),
        FOREIGN KEY(owner_id,item_id) REFERENCES rag_items(owner_id,id) ON DELETE CASCADE
      );
      CREATE TABLE rag_profile_history (
        owner_id UUID NOT NULL, fact_id UUID NOT NULL, version INT NOT NULL, snapshot JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,fact_id,version),
        FOREIGN KEY(owner_id,fact_id) REFERENCES rag_profile_facts(owner_id,id) ON DELETE CASCADE
      );
      CREATE TABLE rag_profile_candidates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value JSONB, operation TEXT NOT NULL CHECK(operation IN ('set','delete')),
        source TEXT NOT NULL, source_id TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ,
        UNIQUE(owner_id,source_id,key,operation)
      );
      CREATE INDEX rag_profile_candidates_owner ON rag_profile_candidates(owner_id,created_at DESC,id DESC);
      CREATE TABLE rag_storage_leases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 minutes'
      );
      CREATE TABLE rag_backup_windows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), retain_until TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  },
};
