import type { Migration } from "../migration-runner.js";

export const marketingAnalysisUploads: Migration = {
  version: 45, name: "marketing-analysis-uploads",
  async up(client) {
    await client.query(`CREATE TABLE marketing_analysis_uploads (
      id UUID PRIMARY KEY, user_id VARCHAR(100) NOT NULL, original_name TEXT NOT NULL,
      media_key TEXT NOT NULL, mime TEXT NOT NULL, size_bytes BIGINT NOT NULL CHECK(size_bytes>0 AND size_bytes<=104857600),
      source_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expired_at TIMESTAMPTZ
    );
    CREATE INDEX marketing_analysis_uploads_owner ON marketing_analysis_uploads(user_id,created_at);
    CREATE INDEX marketing_analysis_uploads_cleanup ON marketing_analysis_uploads(created_at) WHERE expired_at IS NULL;`);
  },
};
