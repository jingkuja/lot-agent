import type { Migration } from "../migration-runner.js";

/** Review and publication model calls share the text operation receipts used by copy and storyboard. */
export const marketingTextOperationKinds: Migration = {
  version: 50, name: "marketing-text-operation-kinds",
  async up(client) {
    await client.query(`ALTER TABLE marketing_text_operations
      DROP CONSTRAINT marketing_text_operations_kind_check,
      ADD CONSTRAINT marketing_text_operations_kind_check CHECK(kind IN ('copy','storyboard','review','publication'));`);
  },
};
