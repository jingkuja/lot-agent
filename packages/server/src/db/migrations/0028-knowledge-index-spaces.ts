import type { Migration } from "../migration-runner.js";
export const knowledgeIndexSpaces: Migration = {
  version: 28, name: "knowledge-index-spaces",
  async up(client) {
    await client.query(`
      ALTER TABLE rag_chunks DROP CONSTRAINT rag_chunks_owner_id_revision_id_ordinal_key;
      ALTER TABLE rag_chunks ADD UNIQUE(owner_id,revision_id,profile_id,ordinal);
      CREATE TABLE rag_index_spaces (
        profile_id TEXT PRIMARY KEY REFERENCES rag_index_profiles(id), table_name TEXT NOT NULL,
        dimensions INT NOT NULL CHECK(dimensions BETWEEN 1 AND 8192), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO rag_index_spaces(profile_id,table_name,dimensions) SELECT id,'rag_chunks',1024 FROM rag_index_profiles;
      CREATE TABLE rag_user_index_state (
        owner_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        active_profile_id TEXT NOT NULL REFERENCES rag_index_profiles(id), previous_profile_id TEXT REFERENCES rag_index_profiles(id),
        version INT NOT NULL DEFAULT 1, switched_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO rag_user_index_state(owner_id,active_profile_id)
        SELECT DISTINCT ON(ch.owner_id) ch.owner_id,ch.profile_id FROM rag_chunks ch JOIN rag_items i ON i.owner_id=ch.owner_id AND i.id=ch.item_id AND i.active_revision_id=ch.revision_id WHERE i.deleted_at IS NULL ORDER BY ch.owner_id,i.updated_at DESC,i.id;
      CREATE TABLE rag_revision_indexes (
        owner_id UUID NOT NULL, item_id UUID NOT NULL, revision_id UUID NOT NULL,
        profile_id TEXT NOT NULL REFERENCES rag_index_profiles(id), chunk_count INT NOT NULL CHECK(chunk_count>0), completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(owner_id,revision_id,profile_id), FOREIGN KEY(owner_id,item_id,revision_id) REFERENCES rag_item_revisions(owner_id,item_id,id) ON DELETE CASCADE
      );
      INSERT INTO rag_revision_indexes(owner_id,item_id,revision_id,profile_id,chunk_count) SELECT owner_id,item_id,revision_id,profile_id,count(*) FROM rag_chunks GROUP BY owner_id,item_id,revision_id,profile_id;
      CREATE TABLE rag_profile_builds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_profile_id TEXT NOT NULL REFERENCES rag_index_profiles(id), target_profile_id TEXT NOT NULL REFERENCES rag_index_profiles(id),
        status TEXT NOT NULL DEFAULT 'building' CHECK(status IN ('building','ready','switched','cancelled')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(owner_id,id)
      );
      CREATE TABLE rag_profile_build_items (
        owner_id UUID NOT NULL, build_id UUID NOT NULL, item_id UUID NOT NULL, revision_id UUID NOT NULL,
        artifact JSONB, PRIMARY KEY(owner_id,build_id,item_id),
        FOREIGN KEY(owner_id,build_id) REFERENCES rag_profile_builds(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id,item_id,revision_id) REFERENCES rag_item_revisions(owner_id,item_id,id) ON DELETE CASCADE
      );
    `);
  },
};
