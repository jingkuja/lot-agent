import type { Migration } from "../migration-runner.js";

/** A text request that reached the gateway but got nothing back ends `cancelled`: not
 * charged, retryable, and kept with its gateway request ID (in `receipt`) for refund checks. */
export const marketingTextCancelled: Migration = {
  version: 54, name: "marketing-text-cancelled",
  async up(client) {
    await client.query(`ALTER TABLE marketing_text_operations
      DROP CONSTRAINT marketing_text_operations_status_check,
      ADD CONSTRAINT marketing_text_operations_status_check CHECK(status IN ('running','unknown','needs_apply','failed','cancelled','succeeded','conflict','released'));
      CREATE INDEX marketing_text_operations_cancelled ON marketing_text_operations(updated_at) WHERE status='cancelled';`);
  },
};
