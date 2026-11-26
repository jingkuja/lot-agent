import type { Migration } from "../migration-runner.js";

export const comicDramaEditTasks: Migration = {
  version: 108,
  name: "comic-drama-edit-tasks",
  async up(client) {
    await client.query(`
      CREATE TABLE lot_comic_drama.cd_edit_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        drama_id UUID NOT NULL,
        last_series_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (owner_id, id),
        UNIQUE (owner_id, drama_id),
        FOREIGN KEY (owner_id, drama_id)
          REFERENCES lot_comic_drama.cd_dramas(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id, last_series_id)
          REFERENCES lot_comic_drama.cd_series(owner_id, id) ON DELETE SET NULL (last_series_id)
      );

      CREATE INDEX cd_edit_tasks_owner_updated_idx
        ON lot_comic_drama.cd_edit_tasks(owner_id, updated_at DESC, id DESC);

      ALTER TABLE lot_comic_drama.cd_edits
        ADD COLUMN drama_edit_task_id UUID,
        ADD FOREIGN KEY (owner_id, drama_edit_task_id)
          REFERENCES lot_comic_drama.cd_edit_tasks(owner_id, id) ON DELETE CASCADE;

      CREATE UNIQUE INDEX cd_edits_task_episode_unique
        ON lot_comic_drama.cd_edits(owner_id, drama_edit_task_id, series_id)
        WHERE drama_edit_task_id IS NOT NULL AND series_id IS NOT NULL;

      CREATE INDEX cd_edits_free_listing
        ON lot_comic_drama.cd_edits(owner_id, updated_at DESC, id DESC)
        WHERE drama_edit_task_id IS NULL;

      INSERT INTO lot_comic_drama.cd_edit_tasks (owner_id, drama_id, created_at, updated_at)
      SELECT d.owner_id, d.id, d.created_at, d.updated_at
      FROM lot_comic_drama.cd_dramas d
      WHERE d.deleted_at IS NULL
      ON CONFLICT (owner_id, drama_id) DO NOTHING;
    `);
  },
};
