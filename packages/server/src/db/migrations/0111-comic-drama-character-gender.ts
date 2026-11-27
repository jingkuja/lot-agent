import type { Migration } from "../migration-runner.js";

export const comicDramaCharacterGender: Migration = {
  version: 111,
  name: "comic-drama-character-gender",
  async up(client) {
    await client.query(`ALTER TABLE lot_comic_drama.cd_characters
      ADD COLUMN gender TEXT CHECK (gender IN ('male','female','other'))`);
  },
};
