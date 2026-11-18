import type { Migration } from "../migration-runner.js";

export const comicDramaGeneration: Migration = {
  version: 87, name: "comic-drama-generation",
  async up(client) {
    await client.query(`
      CREATE TABLE lot_comic_drama.cd_generation_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        series_id UUID,
        character_id UUID,
        frozen JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        task_id UUID UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
        confirmed_at TIMESTAMPTZ,
        CHECK (num_nonnulls(series_id,character_id)=1),
        UNIQUE (owner_id,id),
        FOREIGN KEY (owner_id,series_id) REFERENCES lot_comic_drama.cd_series(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,character_id) REFERENCES lot_comic_drama.cd_characters(owner_id,id) ON DELETE CASCADE
      );
      CREATE INDEX cd_generation_expiry ON lot_comic_drama.cd_generation_requests(expires_at) WHERE confirmed_at IS NULL;

      CREATE TABLE lot_comic_drama.cd_takes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL,
        request_id UUID NOT NULL,
        target_id UUID NOT NULL,
        target_key TEXT NOT NULL,
        slot INTEGER NOT NULL CHECK (slot>=0),
        input JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ready','failed','recoverable','unknown')),
        media_id UUID,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        CHECK ((status='ready')=(media_id IS NOT NULL)),
        UNIQUE (request_id,slot),
        UNIQUE (request_id,target_key),
        UNIQUE (target_id,id),
        FOREIGN KEY (owner_id,request_id) REFERENCES lot_comic_drama.cd_generation_requests(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,media_id) REFERENCES lot_comic_drama.cd_media(owner_id,id)
      );
      CREATE UNIQUE INDEX cd_take_active_target ON lot_comic_drama.cd_takes(owner_id,target_key)
        WHERE status IN ('pending','running','recoverable','unknown');
      CREATE INDEX cd_take_target_history ON lot_comic_drama.cd_takes(owner_id,target_id,created_at DESC,id DESC);
      CREATE INDEX cd_take_completed_history ON lot_comic_drama.cd_takes(owner_id,completed_at DESC,id DESC) WHERE completed_at IS NOT NULL;

      ALTER TABLE lot_comic_drama.cd_clips ADD COLUMN keyframe_take_id UUID,
        ADD FOREIGN KEY (id,keyframe_take_id) REFERENCES lot_comic_drama.cd_takes(target_id,id) ON DELETE SET NULL (keyframe_take_id);
      ALTER TABLE image_call_receipts ADD COLUMN gateway_request_id TEXT;
      CREATE INDEX cd_running_image_tasks ON tasks(updated_at,id) WHERE type='comic-drama.image' AND status='running';
    `);
  },
};
