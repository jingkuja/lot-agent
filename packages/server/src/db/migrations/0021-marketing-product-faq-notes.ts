import type { Migration } from "../migration-runner.js";

/** DE-native FAQ + free-text product notes so marketing copy can consume typed
 * materials without waiting on the platform RAG portal (trial feedback A6). */
export const marketingProductFaqNotes: Migration = {
  version: 21,
  name: "marketing-product-faq-notes",
  async up(client) {
    await client.query(`
      ALTER TABLE marketing_products
        ADD COLUMN IF NOT EXISTS faqs JSONB NOT NULL DEFAULT '[]'
          CHECK (jsonb_typeof(faqs) = 'array'),
        ADD COLUMN IF NOT EXISTS product_notes TEXT NOT NULL DEFAULT '';
    `);
  },
};
