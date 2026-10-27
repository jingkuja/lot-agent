import type { Migration } from "../migration-runner.js";

/** Copy and storyboard a draft held before an AI result, a save that dropped its shots, or a restore
 * replaced them (assessment M04). The newest ten per draft are kept; restoring one is free. */
export const marketingDraftSnapshots: Migration = {
  version: 63, name: "marketing-draft-snapshots",
  async up(client) {
    await client.query(`CREATE TABLE marketing_draft_snapshots (
      id UUID PRIMARY KEY, user_id VARCHAR(100) NOT NULL,
      project_id UUID NOT NULL REFERENCES marketing_video_projects(id),
      project_version INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('copy','storyboard','clear','restore')),
      draft JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX marketing_draft_snapshots_project ON marketing_draft_snapshots(user_id,project_id,created_at DESC);`);
  },
};
