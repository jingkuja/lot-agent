import type { Migration } from "../migration-runner.js";

/** Redoing single shots starts a new job for the same draft. Earlier jobs keep their
 * segment rows: kept clips and old outputs stay traceable to the draft for usage and deletion. */
export const marketingShotRevisions: Migration = {
  version: 53, name: "marketing-shot-revisions",
  async up(client) {
    await client.query(`ALTER TABLE marketing_video_segments DROP CONSTRAINT marketing_video_segments_pkey;
      ALTER TABLE marketing_video_segments ADD PRIMARY KEY(task_id);
      CREATE INDEX marketing_video_segments_project ON marketing_video_segments(project_id, slot);`);
  },
};
