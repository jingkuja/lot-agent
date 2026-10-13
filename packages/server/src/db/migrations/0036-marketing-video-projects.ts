import type { Migration } from "../migration-runner.js";

export const marketingVideoProjects: Migration = {
  version: 36, name: "marketing-video-projects",
  async up(client) {
    await client.query(`
      CREATE TABLE marketing_video_projects (
        id UUID PRIMARY KEY, user_id VARCHAR(100) NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, draft JSONB NOT NULL,
        review JSONB, reviewed_script TEXT,
        task_id UUID REFERENCES tasks(id),
        knowledge_item_id UUID REFERENCES rag_items(id) ON DELETE SET NULL,
        knowledge_version INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE usage_logs ADD COLUMN idempotency_key TEXT;
      CREATE UNIQUE INDEX usage_logs_idempotency ON usage_logs(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX marketing_video_projects_owner ON marketing_video_projects(user_id, updated_at DESC);
      CREATE TABLE marketing_video_segments (
        project_id UUID NOT NULL REFERENCES marketing_video_projects(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 3),
        task_id UUID NOT NULL REFERENCES tasks(id),
        script TEXT NOT NULL, duration_sec INTEGER NOT NULL CHECK(duration_sec BETWEEN 4 AND 15),
        PRIMARY KEY(project_id, slot)
      );
    `);
  },
};
