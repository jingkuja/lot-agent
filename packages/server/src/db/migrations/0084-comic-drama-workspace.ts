import type { Migration } from "../migration-runner.js";

export const comicDramaWorkspace: Migration = {
  version: 84,
  name: "comic-drama-workspace",
  async up(client) {
    await client.query(`
      CREATE SCHEMA lot_comic_drama;

      CREATE TABLE lot_comic_drama.cd_series (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id UUID,
        title TEXT NOT NULL,
        logline TEXT NOT NULL DEFAULT '',
        series_group TEXT,
        episode_no INTEGER CHECK (episode_no > 0),
        style_key TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL CHECK (aspect_ratio IN ('9:16','16:9','1:1')),
        video_model TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        archived_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        UNIQUE (owner_id, id),
        FOREIGN KEY (owner_id, parent_id) REFERENCES lot_comic_drama.cd_series(owner_id, id)
      );
      CREATE INDEX cd_series_history ON lot_comic_drama.cd_series(owner_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;

      CREATE TABLE lot_comic_drama.cd_user_state (
        owner_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        current_series_id UUID,
        FOREIGN KEY (owner_id, current_series_id) REFERENCES lot_comic_drama.cd_series(owner_id, id)
      );

      CREATE TABLE lot_comic_drama.cd_scripts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        series_id UUID NOT NULL REFERENCES lot_comic_drama.cd_series(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        content TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('user','assistant')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (series_id, version)
      );

      CREATE TABLE lot_comic_drama.cd_clips (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        series_id UUID NOT NULL REFERENCES lot_comic_drama.cd_series(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        draft JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (series_id, ordinal) DEFERRABLE INITIALLY DEFERRED
      )
    `);
  },
};
