import type { Migration } from "../migration-runner.js";

/**
 * An owner can drop a file before any product exists, so a document may wait without one until the
 * review is saved. The import's state sits on the document: the same job parses it and sorts it.
 */
export const productDocumentImports: Migration = {
  version: 75, name: "product-document-imports",
  async up(client) {
    await client.query(`
      ALTER TABLE marketing_product_documents
        ALTER COLUMN product_id DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS import_status TEXT NOT NULL DEFAULT 'none'
          CHECK (import_status IN ('none', 'queued', 'running', 'ready', 'failed')),
        ADD COLUMN IF NOT EXISTS import_error TEXT,
        ADD COLUMN IF NOT EXISTS import_draft_id UUID,
        ADD COLUMN IF NOT EXISTS import_conversation_id UUID;
      CREATE INDEX IF NOT EXISTS idx_marketing_product_documents_imports
        ON marketing_product_documents (user_id, updated_at DESC) WHERE import_status <> 'none' AND deleted_at IS NULL;
    `);
  },
};
