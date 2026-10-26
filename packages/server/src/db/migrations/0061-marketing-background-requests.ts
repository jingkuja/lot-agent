import type { Migration } from "../migration-runner.js";

/** Key-art stills and the narration takes of shot redos run in the background (T05), so their
 * outcome is kept in the row the studio polls. Key art: `vendor_task_id` and `result_url` are
 * saved as soon as the image model returns them, so a failed download or an interrupted wait is
 * retried without a second paid request (`resumable`). `error` is the message the studio shows. */
export const marketingBackgroundRequests: Migration = {
  version: 61, name: "marketing-background-requests",
  async up(client) {
    await client.query(`ALTER TABLE marketing_video_key_arts
        ADD COLUMN vendor_task_id TEXT,
        ADD COLUMN result_url TEXT,
        ADD COLUMN resumable BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN error TEXT;
      ALTER TABLE marketing_video_narrations ADD COLUMN error TEXT;`);
  },
};
