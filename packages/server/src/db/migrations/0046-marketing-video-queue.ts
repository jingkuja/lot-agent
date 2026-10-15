import type { Migration } from "../migration-runner.js";

export const marketingVideoQueue: Migration = {
  version: 46, name: "marketing-video-queue",
  async up(client) {
    // Redis entries keep their task IDs. The ordinary worker forwards legacy
    // marketing entries without claiming or executing their paid work.
    await client.query(`UPDATE tasks SET queue_name='lot-marketing-video'
      WHERE type='marketing.video' AND queue_name='lot-tasks'`);
  },
};
