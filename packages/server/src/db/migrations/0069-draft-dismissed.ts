import type { Migration } from "../migration-runner.js";

const DRAFT_TABLES: Array<[table: string, statuses: string[]]> = [
  ["de_customer_capture_drafts", ["prepared", "awaiting_confirmation", "applied", "rejected", "expired", "dismissed"]],
  ["de_customer_profile_change_drafts", ["prepared", "awaiting_confirmation", "applied", "expired", "dismissed"]],
  ["de_conversation_action_drafts", ["prepared", "awaiting_confirmation", "applied", "expired", "dismissed"]],
];

/**
 * Proposals can now be refused outside the conversation. `claimed_at` marks a commit in
 * progress, so a confirmation from the today page and one from the chat cannot both apply.
 */
export const draftDismissed: Migration = {
  version: 69, name: "draft-dismissed",
  async up(client) {
    for (const [table, statuses] of DRAFT_TABLES) {
      const values = statuses.map((status) => `'${status}'`).join(", ");
      await client.query(`
        ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_status_check;
        ALTER TABLE ${table} ADD CONSTRAINT ${table}_status_check CHECK (status IN (${values}));
      `);
    }
    await client.query(`ALTER TABLE de_conversation_action_drafts ADD COLUMN claimed_at TIMESTAMPTZ;`);
  },
};
