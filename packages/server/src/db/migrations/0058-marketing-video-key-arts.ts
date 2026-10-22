import type { Migration } from "../migration-runner.js";

/** Key-art stills of a marketing draft: one generated image of the presenter in the main
 * setting that every clip and shot redo gets as a shared reference. `basis` covers what the
 * still shows, so an edit leaves the old still unused. Each generation is its own row,
 * written as `running` before the billed image request and never resent automatically; at
 * most one may run per look. The image is a private upload asset deleted with the draft. */
export const marketingVideoKeyArts: Migration = {
  version: 58, name: "marketing-video-key-arts",
  async up(client) {
    await client.query(`CREATE TABLE marketing_video_key_arts (
        id UUID PRIMARY KEY,
        owner_id VARCHAR(100) NOT NULL,
        project_id UUID NOT NULL REFERENCES marketing_video_projects(id) ON DELETE CASCADE,
        basis TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
        asset_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK(status <> 'succeeded' OR asset_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX marketing_video_key_arts_running ON marketing_video_key_arts(owner_id, project_id, basis) WHERE status='running';
      CREATE INDEX marketing_video_key_arts_project ON marketing_video_key_arts(owner_id, project_id, basis, updated_at DESC);`);
  },
};
