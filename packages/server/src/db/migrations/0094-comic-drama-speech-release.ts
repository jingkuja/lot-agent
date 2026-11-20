import type { Migration } from "../migration-runner.js";

export const comicDramaSpeechRelease: Migration = {
  version: 94, name: "comic-drama-speech-release",
  async up(db) {
    await db.query(`
      ALTER TABLE lot_comic_drama.cd_speech_cache
        DROP CONSTRAINT IF EXISTS cd_speech_cache_status_check,
        ADD CONSTRAINT cd_speech_cache_status_check CHECK (status IN ('submitting','ready','failed','unknown','released'));
    `);
  },
};
