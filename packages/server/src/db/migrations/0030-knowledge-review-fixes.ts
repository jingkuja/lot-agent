import type { Migration } from "../migration-runner.js";
export const knowledgeReviewFixes: Migration = {
  version: 30, name: "knowledge-review-fixes",
  async up(client) {
    await client.query(`ALTER TABLE rag_embedding_charges ADD COLUMN credential_fingerprint TEXT;
      ALTER TABLE rag_embedding_charges ADD COLUMN provider_route TEXT;
      ALTER TABLE rag_embedding_charges DROP CONSTRAINT rag_embedding_charges_owner_id_request_id_key;
      ALTER TABLE rag_embedding_charges ADD UNIQUE(owner_id,credential_fingerprint,request_id);
      CREATE INDEX rag_embedding_charges_pending_scope ON rag_embedding_charges(owner_id,credential_fingerprint) WHERE total_cost IS NULL;
      ALTER TABLE rag_items ADD COLUMN material_source TEXT NOT NULL DEFAULT 'upload' CHECK(material_source IN ('upload','generated'));
      UPDATE rag_items i SET material_source='generated' FROM assets a WHERE i.source_asset_id=a.id AND a.type<>'upload';
      ALTER TABLE rag_item_revisions DROP CONSTRAINT rag_item_revisions_index_status_check;
      ALTER TABLE rag_item_revisions ADD CONSTRAINT rag_item_revisions_index_status_check CHECK(index_status IN ('pending','processing','ready','failed','cancelled','stored_only'));
      UPDATE rag_item_revisions r SET index_status='stored_only' FROM rag_items i
        WHERE r.owner_id=i.owner_id AND r.item_id=i.id AND r.id=i.pending_revision_id
          AND i.source_type IN ('bookmark','image','audio','video') AND r.description ~ '^[[:space:]]*$';
      UPDATE tasks t SET status='cancelled',updated_at=now() FROM rag_ingestion_runs g JOIN rag_item_revisions r ON r.id=g.revision_id
        WHERE t.id=g.task_id AND r.index_status='stored_only' AND t.status IN ('pending','running');
      UPDATE rag_ingestion_runs g SET status='cancelled',lease_token=NULL,lease_expires_at=NULL FROM rag_item_revisions r
        WHERE r.id=g.revision_id AND r.index_status='stored_only';
      UPDATE rag_items i SET active_revision_id=pending_revision_id,pending_revision_id=NULL,generation=i.generation+1
        FROM rag_item_revisions r WHERE r.id=i.pending_revision_id AND r.index_status='stored_only';`);
  },
};
