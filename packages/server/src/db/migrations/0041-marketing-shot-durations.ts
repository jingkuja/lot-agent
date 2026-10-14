import type { Migration } from "../migration-runner.js";

export const marketingShotDurations: Migration = {
  version: 41, name: "marketing-shot-durations",
  async up(client) {
    await client.query(`ALTER TABLE marketing_video_segments DROP CONSTRAINT marketing_video_segments_slot_check;
      ALTER TABLE marketing_video_segments ADD CONSTRAINT marketing_video_segments_slot_check CHECK(slot BETWEEN 0 AND 14);`);
  },
};
