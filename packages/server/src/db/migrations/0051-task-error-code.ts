import type { Migration } from "../migration-runner.js";

/** Failure cause stored next to the message, so clients never classify error text. */
export const taskErrorCode: Migration = {
  version: 51, name: "task-error-code",
  async up(client) {
    await client.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS error_code TEXT");
  },
};
