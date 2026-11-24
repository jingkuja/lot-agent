import type { Migration } from "../migration-runner.js";

export const comicDramaReferenceVideo: Migration = {
  version: 100, name: "comic-drama-reference-video",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_media DROP CONSTRAINT cd_media_mime_check,
        ADD CONSTRAINT cd_media_mime_check CHECK (
          mime IN ('image/jpeg','image/png','image/webp','audio/mpeg','audio/wav','video/mp4','video/quicktime')
        );
    `);
  },
};
