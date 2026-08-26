import type { Migration } from "../migration-runner.js";

export const managedNewApiKey: Migration = {
  version: 18,
  name: "managed-new-api-key",
  async up(client) {
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS managed_token_id BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS managed_api_key TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS credential_version INT NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS managed_key_status TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS managed_key_provisioned_at TIMESTAMPTZ;

      CREATE UNIQUE INDEX IF NOT EXISTS users_managed_token_id_unique
        ON users (managed_token_id) WHERE managed_token_id IS NOT NULL;
    `);
  },
};
