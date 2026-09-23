import type { Migration } from "../migration-runner.js";
export const knowledgeIndex: Migration = {
  version: 26, name: "knowledge-index",
  async up(client) {
    // Shared deployment prerequisite; keep the extension in public across test schemas.
    await client.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    await client.query(`
      CREATE TABLE rag_index_profiles (
        id TEXT PRIMARY KEY,
        config JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE rag_item_revisions ADD COLUMN index_profile_id TEXT REFERENCES rag_index_profiles(id);
      CREATE TABLE rag_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL,
        item_id UUID NOT NULL,
        revision_id UUID NOT NULL,
        profile_id TEXT NOT NULL REFERENCES rag_index_profiles(id),
        ordinal INT NOT NULL CHECK (ordinal>=0),
        content TEXT NOT NULL CHECK (length(content)>0),
        origin TEXT NOT NULL,
        citation JSONB,
        input_tokens INT NOT NULL CHECK (input_tokens>0 AND input_tokens<=512),
        overlap_characters INT NOT NULL CHECK (overlap_characters>=0),
        lexical TSVECTOR NOT NULL,
        embedding public.vector(1024) NOT NULL,
        UNIQUE (owner_id,revision_id,ordinal),
        FOREIGN KEY (owner_id,item_id,revision_id) REFERENCES rag_item_revisions(owner_id,item_id,id) ON DELETE CASCADE
      );
      CREATE INDEX rag_chunks_scope ON rag_chunks(owner_id,revision_id,profile_id);
      CREATE INDEX rag_chunks_lexical ON rag_chunks USING gin(lexical);
      CREATE TABLE rag_embedding_charges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        request_id TEXT,
        model_id TEXT NOT NULL,
        input_tokens INT NOT NULL CHECK (input_tokens>0),
        quota_per_unit DOUBLE PRECISION NOT NULL CHECK (quota_per_unit>0),
        exchange_rate DOUBLE PRECISION NOT NULL CHECK (exchange_rate>0),
        total_cost NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id,request_id)
      );
    `);
  },
};
