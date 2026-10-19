import type { Migration } from "../migration-runner.js";

/** A user may explicitly give up an unknown paid outcome; keep when and how often for billing reconciliation. */
export const marketingUnknownRelease: Migration = {
  version: 49, name: "marketing-unknown-release",
  async up(client) {
    await client.query(`ALTER TABLE marketing_text_operations
      ADD COLUMN released_at TIMESTAMPTZ,
      DROP CONSTRAINT marketing_text_operations_status_check,
      ADD CONSTRAINT marketing_text_operations_status_check CHECK(status IN ('running','unknown','needs_apply','failed','succeeded','conflict','released'));
      ALTER TABLE marketing_video_segments
        ADD COLUMN unknown_released_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN unknown_released_at TIMESTAMPTZ;`);
  },
};
