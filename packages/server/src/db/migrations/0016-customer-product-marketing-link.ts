import type { Migration, QueryClient } from "../migration-runner.js";

async function up(client: QueryClient): Promise<void> {
  await client.query(`
    ALTER TABLE de_customer_product_states
      ADD COLUMN IF NOT EXISTS marketing_product_id UUID
        REFERENCES marketing_products(id) ON DELETE SET NULL;

    ALTER TABLE de_customer_observation_extractions
      ADD COLUMN IF NOT EXISTS marketing_product_id UUID
        REFERENCES marketing_products(id) ON DELETE SET NULL;
  `);

  // Preserve existing product relationships where a same-user, same-name
  // marketing product already exists. Active product names are unique per
  // user, so this backfill is deterministic.
  await client.query(`
    UPDATE de_customer_product_states state
       SET marketing_product_id = product.id,
           product_name = product.name
      FROM marketing_products product
     WHERE state.marketing_product_id IS NULL
       AND product.user_id = state.user_id
       AND product.status = 'active'
       AND lower(product.name) = lower(state.product_name);

    UPDATE de_customer_observation_extractions extraction
       SET marketing_product_id = product.id,
           product_name = product.name
      FROM marketing_products product
     WHERE extraction.marketing_product_id IS NULL
       AND product.user_id = extraction.user_id
       AND product.status = 'active'
       AND lower(product.name) = lower(extraction.product_name);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_de_product_states_marketing_product
      ON de_customer_product_states (user_id, marketing_product_id)
      WHERE marketing_product_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_de_extractions_marketing_product
      ON de_customer_observation_extractions (user_id, marketing_product_id)
      WHERE marketing_product_id IS NOT NULL;
  `);
}

export const customerProductMarketingLink: Migration = {
  version: 16,
  name: "customer-product-marketing-link",
  up,
};
