import type { Migration } from "../migration-runner.js";

export const comicDramaQueues: Migration = {
  version: 103,
  name: "comic-drama-queues",
  async up(client) {
    // Re-route persisted comic-drama tasks out of the shared marketing-video queue
    // into isolated per-workload queues. Rolling upgrades remain safe because the
    // marketing-video worker forwards legacy comic entries without claiming them.
    await client.query(`
      UPDATE tasks
      SET queue_name = CASE type
        WHEN 'comic-drama.image' THEN 'lot-comic-image'
        WHEN 'comic-drama.video' THEN 'lot-comic-video'
        WHEN 'comic-drama.render' THEN 'lot-comic-render'
        ELSE queue_name
      END
      WHERE type IN ('comic-drama.image', 'comic-drama.video', 'comic-drama.render')
        AND queue_name IN ('lot-marketing-video', 'lot-tasks')
    `);
  },
};
