import type { Migration } from "../migration-runner.js";

export const marketingTextOperations: Migration = {
  version: 42, name: "marketing-text-operations",
  async up(client) {
    await client.query(`CREATE TABLE marketing_text_operations (
      id UUID NOT NULL, user_id VARCHAR(100) NOT NULL,
      project_id UUID NOT NULL REFERENCES marketing_video_projects(id),
      project_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('copy','storyboard')),
      input_hash TEXT NOT NULL, model TEXT NOT NULL, protocol TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','unknown','failed','succeeded','conflict')),
      receipt JSONB, result JSONB, applied_version INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(user_id,id)
    );
    CREATE INDEX marketing_text_operations_project ON marketing_text_operations(user_id,project_id,created_at DESC);
    CREATE UNIQUE INDEX marketing_text_operations_active ON marketing_text_operations(project_id)
      WHERE status IN ('running','unknown');`);
  },
};
