import type { Migration } from "../migration-runner.js";

/**
 * Supplementary files attached to a marketing product. The parsed text is kept whole even when it
 * is too long for a prompt, so a later search index does not have to parse the file again.
 */
export const marketingProductDocuments: Migration = {
  version: 74, name: "marketing-product-documents",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS marketing_product_documents (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        VARCHAR(100) NOT NULL,
        product_id     UUID NOT NULL REFERENCES marketing_products(id) ON DELETE CASCADE,
        asset_id       UUID REFERENCES assets(id) ON DELETE SET NULL,
        title          TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
        mime           TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
        error_code     TEXT,
        parsed_text    TEXT,
        prompt_chars   INTEGER NOT NULL DEFAULT 0 CHECK (prompt_chars >= 0),
        content_hash   TEXT,
        skipped_pages  INTEGER NOT NULL DEFAULT 0 CHECK (skipped_pages >= 0),
        parser_version TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at     TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_marketing_product_documents_product
        ON marketing_product_documents (user_id, product_id, created_at DESC) WHERE deleted_at IS NULL;
    `);
  },
};
