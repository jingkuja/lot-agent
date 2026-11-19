import type { Migration } from "../migration-runner.js";

export const comicDramaDelivery: Migration = {
  version: 91, name: "comic-drama-delivery",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_renders ADD COLUMN project_title TEXT, ADD COLUMN series_id UUID;
      UPDATE lot_comic_drama.cd_renders r SET project_title=e.title,series_id=e.series_id
        FROM lot_comic_drama.cd_edits e WHERE (e.owner_id,e.id)=(r.owner_id,r.edit_id);
      CREATE INDEX cd_render_owner_history ON lot_comic_drama.cd_renders(owner_id,created_at DESC,id DESC);
      CREATE INDEX cd_render_completed_series ON lot_comic_drama.cd_renders(owner_id,series_id) WHERE media_id IS NOT NULL;

      CREATE TABLE lot_comic_drama.cd_director_sessions (
        owner_id UUID NOT NULL, series_id UUID NOT NULL, conversation_id UUID NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
        PRIMARY KEY (owner_id,series_id),
        UNIQUE (owner_id,series_id,conversation_id),
        FOREIGN KEY (owner_id,series_id) REFERENCES lot_comic_drama.cd_series(owner_id,id) ON DELETE CASCADE
      );
      CREATE TABLE lot_comic_drama.cd_director_proposals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL, series_id UUID NOT NULL, conversation_id UUID NOT NULL, request_id UUID NOT NULL,
        base_revision INT NOT NULL CHECK (base_revision>0), input JSONB NOT NULL,
        original TEXT NOT NULL DEFAULT '',
        proposal JSONB, model TEXT,
        status TEXT NOT NULL CHECK (status IN ('writing','ready','failed','unknown','applied','dismissed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), applied_revision INT,
        UNIQUE (owner_id,series_id,request_id),
        FOREIGN KEY (owner_id,series_id,conversation_id)
          REFERENCES lot_comic_drama.cd_director_sessions(owner_id,series_id,conversation_id) ON DELETE CASCADE
      );
      CREATE INDEX cd_director_recent ON lot_comic_drama.cd_director_proposals(owner_id,series_id,created_at DESC,id DESC);
      CREATE UNIQUE INDEX cd_director_active ON lot_comic_drama.cd_director_proposals(owner_id,series_id) WHERE status='writing';
    `);
  },
};
