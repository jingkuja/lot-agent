import type { Migration } from "../migration-runner.js";

/** Metadata only: vector extension/profile dimensions are enabled with the S2 index schema. */
export const knowledgeFoundation: Migration = {
  version: 24,
  name: "knowledge-foundation",
  async up(client) {
    await client.query(`
      CREATE TABLE rag_collections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
        version INT NOT NULL DEFAULT 1 CHECK (version > 0),
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id, id)
      );
      CREATE INDEX rag_collections_owner_cursor ON rag_collections(owner_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
      CREATE TABLE rag_objects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        storage_key TEXT NOT NULL UNIQUE,
        byte_size BIGINT NOT NULL CHECK (byte_size > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id, sha256),
        UNIQUE (owner_id, id)
      );
      CREATE TABLE rag_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK (source_type IN ('document','note','bookmark','image','audio','video','profile_fact')),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
        version INT NOT NULL DEFAULT 1 CHECK (version > 0),
        generation INT NOT NULL DEFAULT 1 CHECK (generation > 0),
        active_revision_id UUID,
        pending_revision_id UUID,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id, id)
      );
      CREATE INDEX rag_items_owner_cursor ON rag_items(owner_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
      CREATE TABLE rag_item_revisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL,
        item_id UUID NOT NULL,
        object_id UUID,
        revision_number INT NOT NULL CHECK (revision_number > 0),
        generation INT NOT NULL CHECK (generation > 0),
        mime TEXT,
        original_name TEXT,
        content TEXT,
        description TEXT NOT NULL DEFAULT '',
        source_url TEXT,
        storage_status TEXT NOT NULL CHECK (storage_status IN ('stored','failed')),
        index_status TEXT NOT NULL DEFAULT 'pending' CHECK (index_status IN ('pending','processing','ready','failed','cancelled')),
        diagnostics JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id, item_id, id),
        UNIQUE (owner_id, item_id, revision_number),
        FOREIGN KEY (owner_id, item_id) REFERENCES rag_items(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id, object_id) REFERENCES rag_objects(owner_id, id) DEFERRABLE INITIALLY DEFERRED
      );
      ALTER TABLE rag_items ADD CONSTRAINT rag_items_active_revision_fk
        FOREIGN KEY (owner_id, id, active_revision_id) REFERENCES rag_item_revisions(owner_id, item_id, id) DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE rag_items ADD CONSTRAINT rag_items_pending_revision_fk
        FOREIGN KEY (owner_id, id, pending_revision_id) REFERENCES rag_item_revisions(owner_id, item_id, id) DEFERRABLE INITIALLY DEFERRED;
      CREATE INDEX rag_revisions_object_refs ON rag_item_revisions(owner_id, object_id) WHERE object_id IS NOT NULL;
      CREATE TABLE rag_collection_items (
        owner_id UUID NOT NULL,
        collection_id UUID NOT NULL,
        item_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, collection_id, item_id),
        FOREIGN KEY (owner_id, collection_id) REFERENCES rag_collections(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id, item_id) REFERENCES rag_items(owner_id, id) ON DELETE CASCADE
      );
      CREATE INDEX rag_collection_items_item ON rag_collection_items(owner_id, item_id);
      CREATE TABLE rag_item_tags (
        owner_id UUID NOT NULL,
        item_id UUID NOT NULL,
        tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 100),
        PRIMARY KEY (owner_id, item_id, tag),
        FOREIGN KEY (owner_id, item_id) REFERENCES rag_items(owner_id, id) ON DELETE CASCADE
      );
      CREATE TABLE rag_idempotency (
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        route TEXT NOT NULL,
        key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
        request_hash CHAR(64) NOT NULL,
        response JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, route, key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_user_id_id_unique ON sessions(user_id,id);
      CREATE TABLE rag_preview_tickets (
        token_hash CHAR(64) PRIMARY KEY,
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id UUID NOT NULL,
        item_id UUID NOT NULL,
        revision_id UUID NOT NULL,
        generation INT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (owner_id, session_id) REFERENCES sessions(user_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id, item_id, revision_id) REFERENCES rag_item_revisions(owner_id, item_id, id) ON DELETE CASCADE
      );
      CREATE INDEX rag_preview_tickets_expiry ON rag_preview_tickets(expires_at);
    `);
  },
};
