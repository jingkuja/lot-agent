import type { Migration } from "../migration-runner.js";

export const comicDramaVoices: Migration = {
  version: 110,
  name: "comic-drama-voices",
  async up(client) {
    await client.query(`
      CREATE TABLE lot_comic_drama.cd_voices (
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        id UUID NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('design','clone')),
        voice_prompt TEXT,
        preview_text TEXT,
        preview_media_id UUID,
        target_model TEXT NOT NULL,
        credential_scope TEXT NOT NULL,
        prefix TEXT NOT NULL UNIQUE,
        voice_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('unknown','DEPLOYING','OK','UNDEPLOYED','failed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        archived_at TIMESTAMPTZ,
        PRIMARY KEY (owner_id, id),
        FOREIGN KEY (owner_id, preview_media_id) REFERENCES lot_comic_drama.cd_media(owner_id, id),
        CHECK ((voice_id IS NOT NULL) = (status IN ('DEPLOYING','OK','UNDEPLOYED')))
      );
      CREATE INDEX cd_voices_listing ON lot_comic_drama.cd_voices(owner_id, created_at DESC, id DESC);
    `);
  },
};
