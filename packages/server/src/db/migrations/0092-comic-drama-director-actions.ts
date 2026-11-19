import type { Migration } from "../migration-runner.js";

export const comicDramaDirectorActions: Migration = {
  version: 92, name: "comic-drama-director-actions",
  async up(db) {
    await db.query(`
      ALTER TABLE lot_comic_drama.cd_director_proposals ADD COLUMN decision TEXT, ADD COLUMN sequel_id UUID;
      CREATE TABLE lot_comic_drama.cd_director_roles (
        proposal_id UUID NOT NULL REFERENCES lot_comic_drama.cd_director_proposals(id) ON DELETE CASCADE,
        role_index INT NOT NULL, outcome JSONB NOT NULL, PRIMARY KEY (proposal_id,role_index)
      );
      CREATE TABLE lot_comic_drama.cd_director_quotes (
        confirmation_id UUID PRIMARY KEY REFERENCES lot_comic_drama.cd_generation_requests(id) ON DELETE CASCADE,
        owner_id UUID NOT NULL, series_id UUID NOT NULL, conversation_id UUID NOT NULL, quote JSONB NOT NULL,
        FOREIGN KEY (owner_id,series_id,conversation_id)
          REFERENCES lot_comic_drama.cd_director_sessions(owner_id,series_id,conversation_id) ON DELETE CASCADE
      );
      CREATE INDEX cd_director_quotes_scope ON lot_comic_drama.cd_director_quotes(owner_id,series_id);
    `);
  },
};
