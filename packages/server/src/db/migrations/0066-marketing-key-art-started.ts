import type { Migration } from "../migration-runner.js";

/** When the current try of a key-art still started (created, or resumed with 继续获取), so the studio can show
 * how long it has been made and allow making it again after 2 minutes. Existing rows stay NULL and fall back to `created_at`. */
export const marketingKeyArtStarted: Migration = {
  version: 66, name: "marketing-key-art-started",
  async up(client) {
    await client.query(`ALTER TABLE marketing_video_key_arts ADD COLUMN started_at TIMESTAMPTZ;
      ALTER TABLE marketing_video_key_arts ALTER COLUMN started_at SET DEFAULT now();`);
  },
};
