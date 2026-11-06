import type { Migration } from "../migration-runner.js";

/** Pictures already read, kept until parsing finishes, so a retry does not pay for them twice. */
export const productDocumentOcrPages: Migration = {
  version: 76, name: "product-document-ocr-pages",
  async up(client) {
    await client.query(`
      ALTER TABLE marketing_product_documents ADD COLUMN IF NOT EXISTS ocr_pages JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
  },
};
