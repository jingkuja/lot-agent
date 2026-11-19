import type { Migration } from "../migration-runner.js";

export const comicDramaRenders: Migration = {
  version: 90, name: "comic-drama-renders",
  async up(client) {
    await client.query(`
      CREATE TABLE lot_comic_drama.cd_renders (
        id UUID PRIMARY KEY,
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_id UUID NOT NULL,
        edit_id UUID NOT NULL,
        edit_revision INT NOT NULL CHECK (edit_revision>0),
        frozen JSONB NOT NULL CHECK (frozen->>'schemaVersion'='1'),
        duration_ms INT NOT NULL CHECK (duration_ms>0),
        media_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id,id), UNIQUE (owner_id,request_id),
        FOREIGN KEY (owner_id,media_id) REFERENCES lot_comic_drama.cd_media(owner_id,id)
      );
      CREATE INDEX cd_render_edit ON lot_comic_drama.cd_renders(owner_id,edit_id,created_at DESC,id DESC);
      CREATE TABLE lot_comic_drama.cd_render_takes (
        owner_id UUID NOT NULL, render_id UUID NOT NULL, take_id UUID NOT NULL, media_id UUID NOT NULL,
        PRIMARY KEY (render_id,take_id),
        FOREIGN KEY (owner_id,render_id) REFERENCES lot_comic_drama.cd_renders(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,take_id) REFERENCES lot_comic_drama.cd_takes(owner_id,id),
        FOREIGN KEY (owner_id,media_id) REFERENCES lot_comic_drama.cd_media(owner_id,id)
      );
      CREATE INDEX cd_render_take_references ON lot_comic_drama.cd_render_takes(owner_id,take_id);
      CREATE TABLE lot_comic_drama.cd_render_media (
        owner_id UUID NOT NULL, render_id UUID NOT NULL, media_id UUID NOT NULL,
        PRIMARY KEY (render_id,media_id),
        FOREIGN KEY (owner_id,render_id) REFERENCES lot_comic_drama.cd_renders(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,media_id) REFERENCES lot_comic_drama.cd_media(owner_id,id)
      );
      CREATE INDEX cd_render_media_references ON lot_comic_drama.cd_render_media(owner_id,media_id);
    `);
  },
};
