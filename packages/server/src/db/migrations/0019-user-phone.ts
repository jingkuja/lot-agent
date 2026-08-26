import type { Migration } from "../migration-runner.js";

export const userPhone: Migration = {
  version: 19,
  name: "user-phone",
  async up(client) {
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(32);
    `);
  },
};
