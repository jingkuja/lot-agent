import type { Migration } from "../migration-runner.js";

export const marketingReferenceAnalysis: Migration = {
  version: 39, name: "marketing-reference-analysis",
  async up(client) {
    await client.query(`
      CREATE TABLE marketing_reference_sources (
        id UUID PRIMARY KEY, user_id VARCHAR(100) NOT NULL, share_text TEXT NOT NULL,
        platform TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE marketing_reference_analyses (
        id UUID PRIMARY KEY REFERENCES tasks(id), user_id VARCHAR(100) NOT NULL,
        source_id UUID NOT NULL REFERENCES marketing_reference_sources(id),
        client_request_id UUID NOT NULL, input_hash TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
        pipeline_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'queued',
        snapshot JSONB NOT NULL, selection JSONB, mode TEXT NOT NULL DEFAULT 'all', error_code TEXT,
        pricing JSONB NOT NULL, budget_limit NUMERIC(18,8) NOT NULL CHECK(budget_limit>0),
        reserved_cost NUMERIC(18,8) NOT NULL DEFAULT 0, spent NUMERIC(18,8) NOT NULL DEFAULT 0,
        lease_token UUID, lease_until TIMESTAMPTZ, cancel_requested BOOLEAN NOT NULL DEFAULT false,
        deleted_at TIMESTAMPTZ, files_cleaned_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id,client_request_id), UNIQUE(id,user_id),
        CHECK(status IN ('queued','running','needs_auth','needs_review','partial','ready','failed','cancelled'))
      );
      CREATE INDEX marketing_reference_analyses_owner ON marketing_reference_analyses(user_id,updated_at DESC);
      CREATE INDEX marketing_reference_analyses_dispatch ON marketing_reference_analyses(status,lease_until) WHERE deleted_at IS NULL;
      CREATE TABLE marketing_analysis_steps (
        analysis_id UUID NOT NULL, user_id VARCHAR(100) NOT NULL, step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, input_hash TEXT NOT NULL, model TEXT NOT NULL, images INTEGER NOT NULL,
        reserved_cost NUMERIC(18,8) NOT NULL, actual_cost NUMERIC(18,8), receipt JSONB, reconciliation JSONB,
        retry_requested BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(analysis_id,step_id,attempt),
        FOREIGN KEY(analysis_id,user_id) REFERENCES marketing_reference_analyses(id,user_id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TABLE marketing_analysis_revisions (
        analysis_id UUID NOT NULL REFERENCES marketing_reference_analyses(id), revision INTEGER NOT NULL,
        snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(analysis_id,revision)
      );
      CREATE TABLE marketing_analysis_sessions (
        user_id VARCHAR(100) NOT NULL, platform TEXT NOT NULL, encrypted_cookies TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,platform)
      );
      ALTER TABLE marketing_video_projects ADD COLUMN reference_analysis_id UUID REFERENCES marketing_reference_analyses(id);
      ALTER TABLE marketing_video_projects ADD COLUMN reference_revision INTEGER;
      ALTER TABLE marketing_video_projects ADD COLUMN reference_evidence_ids JSONB;
    `);
  },
};
