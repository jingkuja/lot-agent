import type { Migration } from "../migration-runner.js";

/** Up to three pictures of the product itself, for posters and other marketing material. */
export const marketingProductImages: Migration = {
  version: 81, name: "marketing-product-images",
  async up(client) {
    await client.query(`
      ALTER TABLE marketing_products
        ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(images) = 'array')
    `);
  },
};
