import type { Migration } from "../migration-runner.js";

export const comicDramaVideo: Migration = {
  version: 88, name: "comic-drama-video",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_media DROP CONSTRAINT cd_media_mime_check,
        ADD CHECK (mime IN ('image/jpeg','image/png','image/webp','audio/mpeg','audio/wav','video/mp4'));
      ALTER TABLE lot_comic_drama.cd_takes DROP CONSTRAINT cd_takes_status_check,
        ADD CHECK (status IN ('pending','running','ready','failed','recoverable','unknown','cancelled','released')),
        ADD COLUMN video_version INTEGER CHECK (video_version IS NULL OR video_version>0),
        ADD COLUMN progress SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        ADD COLUMN cancel_requested_at TIMESTAMPTZ,
        ADD COLUMN submit_state TEXT CHECK (submit_state IN ('submitting','accepted','output','rejected','unknown')),
        ADD COLUMN vendor_id TEXT,
        ADD COLUMN gateway_request_id TEXT,
        ADD COLUMN gateway_http_status INTEGER,
        ADD COLUMN output_url TEXT,
        ADD CHECK (submit_state IS NULL OR video_version IS NOT NULL),
        ADD CHECK (submit_state NOT IN ('accepted','output') OR vendor_id IS NOT NULL),
        ADD CHECK (submit_state IS DISTINCT FROM 'output' OR output_url IS NOT NULL);
      CREATE UNIQUE INDEX cd_video_versions ON lot_comic_drama.cd_takes(target_id,video_version) WHERE video_version IS NOT NULL;
      ALTER TABLE lot_comic_drama.cd_clips ADD COLUMN adopted_video_take_id UUID,
        ADD FOREIGN KEY (id,adopted_video_take_id) REFERENCES lot_comic_drama.cd_takes(target_id,id) ON DELETE SET NULL (adopted_video_take_id);
      CREATE INDEX cd_running_video_tasks ON tasks(updated_at,id) WHERE type='comic-drama.video' AND status='running';
    `);
  },
};
