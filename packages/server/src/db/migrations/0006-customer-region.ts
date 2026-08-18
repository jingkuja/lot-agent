import type { Migration, QueryClient } from "../migration-runner.js";

/** Free-text customer area. Deliberately not split into province/city/district. */
async function up(client: QueryClient): Promise<void> {
  await client.query(`
    ALTER TABLE de_customer_profiles
    ADD COLUMN IF NOT EXISTS customer_region TEXT
  `);
}

export const customerRegion: Migration = {
  version: 6,
  name: "digital-employee-customer-region",
  up,
};
