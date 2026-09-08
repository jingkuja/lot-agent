import type { Migration } from "../migration-runner.js";

export const uploadOriginalName: Migration = {
  version: 7,
  name: "upload-original-name",
  async up(client) {
    await client.query(`
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS original_name TEXT;
    `);
  },
};
