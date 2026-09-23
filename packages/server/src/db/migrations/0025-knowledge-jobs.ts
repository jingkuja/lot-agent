import type { Migration } from "../migration-runner.js";
export const knowledgeJobs: Migration = {
  version: 25, name: "knowledge-jobs",
  async up(client) {
    await client.query(`
      ALTER TABLE tasks ADD COLUMN queue_name TEXT NOT NULL DEFAULT 'lot-tasks';
      CREATE UNIQUE INDEX tasks_owner_id_id_unique ON tasks(user_id,id);
      CREATE TABLE rag_ingestion_runs (
        task_id UUID PRIMARY KEY,
        owner_id UUID NOT NULL,
        task_owner_id VARCHAR(100) GENERATED ALWAYS AS (owner_id::text) STORED,
        item_id UUID NOT NULL,
        revision_id UUID NOT NULL,
        generation INT NOT NULL CHECK (generation>0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
        attempts INT NOT NULL DEFAULT 0,
        lease_token UUID,
        lease_expires_at TIMESTAMPTZ,
        artifact JSONB,
        artifact_version TEXT,
        error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id, revision_id, generation),
        FOREIGN KEY (task_owner_id,task_id) REFERENCES tasks(user_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (owner_id,item_id,revision_id) REFERENCES rag_item_revisions(owner_id,item_id,id) ON DELETE CASCADE
      );
      CREATE INDEX rag_ingestion_runs_lease ON rag_ingestion_runs(lease_expires_at) WHERE status='running';
      CREATE TABLE rag_outbox (
        task_id UUID PRIMARY KEY REFERENCES rag_ingestion_runs(task_id) ON DELETE CASCADE,
        queue_name TEXT NOT NULL CHECK (queue_name<>'lot-tasks'),
        attempts INT NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        delivered_at TIMESTAMPTZ,
        last_error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX rag_outbox_due ON rag_outbox(queue_name,available_at) WHERE delivered_at IS NULL;
    `);
  },
};
