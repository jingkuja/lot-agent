import type { Migration, QueryClient } from "../migration-runner.js";

/**
 * Customer-profile MVP: slow-moving customer identity, immutable source
 * observations, versioned extraction, materialized product state and audit.
 * All tables are user-scoped; PostgreSQL remains the source of truth while
 * future Redis/BullMQ jobs only schedule work around these records.
 */
async function up(client: QueryClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS de_customer_profiles (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             VARCHAR(100) NOT NULL,
      owner_user_id       VARCHAR(100) NOT NULL,
      display_name        VARCHAR(200) NOT NULL,
      aliases             TEXT[] NOT NULL DEFAULT '{}',
      customer_kind       VARCHAR(24) NOT NULL DEFAULT 'person'
                          CHECK (customer_kind IN ('person', 'organization_contact')),
      organization        VARCHAR(200),
      department          VARCHAR(200),
      title               VARCHAR(200),
      contact_ciphertext  TEXT,
      source              VARCHAR(64),
      relationship_stage  VARCHAR(16) NOT NULL DEFAULT 'lead'
                          CHECK (relationship_stage IN ('lead', 'prospect', 'customer', 'inactive', 'lost')),
      overall_health      VARCHAR(16) NOT NULL DEFAULT 'healthy'
                          CHECK (overall_health IN ('healthy', 'watch', 'at_risk')),
      tags                TEXT[] NOT NULL DEFAULT '{}',
      custom_fields       JSONB NOT NULL DEFAULT '{}',
      summary             TEXT NOT NULL DEFAULT '',
      summary_version     INTEGER NOT NULL DEFAULT 1,
      manual_lock_fields  TEXT[] NOT NULL DEFAULT '{}',
      last_observed_at    TIMESTAMPTZ,
      last_contact_at     TIMESTAMPTZ,
      next_follow_up_at   TIMESTAMPTZ,
      version             INTEGER NOT NULL DEFAULT 1,
      status              VARCHAR(16) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'archived')),
      archived_at         TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_de_profiles_user_status_updated
      ON de_customer_profiles (user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_de_profiles_user_relationship
      ON de_customer_profiles (user_id, relationship_stage);
    CREATE INDEX IF NOT EXISTS idx_de_profiles_user_next_follow_up
      ON de_customer_profiles (user_id, next_follow_up_at);
    CREATE INDEX IF NOT EXISTS idx_de_profiles_tags_gin
      ON de_customer_profiles USING GIN (tags);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_customer_observations (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         VARCHAR(100) NOT NULL,
      profile_id      UUID NOT NULL REFERENCES de_customer_profiles(id) ON DELETE CASCADE,
      source_type     VARCHAR(32) NOT NULL
                      CHECK (source_type IN ('agent_message', 'manual', 'import', 'transaction', 'support')),
      source_id       VARCHAR(200) NOT NULL,
      source_locator  JSONB NOT NULL DEFAULT '{}',
      raw_text        TEXT NOT NULL,
      raw_text_hash   VARCHAR(64) NOT NULL,
      occurred_at     TIMESTAMPTZ,
      supersedes_id   UUID REFERENCES de_customer_observations(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, source_type, source_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_de_observations_user_profile_time
      ON de_customer_observations (user_id, profile_id, occurred_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_de_observations_profile_created
      ON de_customer_observations (profile_id, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_customer_observation_extractions (
      id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                   VARCHAR(100) NOT NULL,
      profile_id                UUID NOT NULL REFERENCES de_customer_profiles(id) ON DELETE CASCADE,
      observation_id            UUID NOT NULL REFERENCES de_customer_observations(id) ON DELETE CASCADE,
      event_type                VARCHAR(32) NOT NULL
                                CHECK (event_type IN ('contact', 'requirement', 'purchase_intent', 'trial', 'purchase', 'product_feedback', 'complaint', 'delivery', 'renewal', 'churn', 'note')),
      product_key               VARCHAR(160),
      product_name              VARCHAR(200),
      extracted_facts           JSONB NOT NULL DEFAULT '{}',
      proposed_patch            JSONB NOT NULL DEFAULT '{}',
      apply_status              VARCHAR(20) NOT NULL
                                CHECK (apply_status IN ('applied', 'partial', 'rejected')),
      confidence                NUMERIC(4,3),
      model_id                  VARCHAR(160),
      prompt_version            VARCHAR(80) NOT NULL,
      schema_version            VARCHAR(80) NOT NULL,
      supersedes_extraction_id  UUID REFERENCES de_customer_observation_extractions(id) ON DELETE SET NULL,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_at                TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_de_extractions_user_observation
      ON de_customer_observation_extractions (user_id, observation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_de_extractions_profile_created
      ON de_customer_observation_extractions (user_id, profile_id, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_customer_product_states (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             VARCHAR(100) NOT NULL,
      profile_id          UUID NOT NULL REFERENCES de_customer_profiles(id) ON DELETE CASCADE,
      product_key         VARCHAR(160) NOT NULL,
      product_name        VARCHAR(200) NOT NULL,
      journey_stage       VARCHAR(16) NOT NULL DEFAULT 'unknown'
                          CHECK (journey_stage IN ('unknown', 'evaluating', 'trial', 'purchased', 'using', 'renewal', 'paused', 'lost', 'churned')),
      sentiment           VARCHAR(16) NOT NULL DEFAULT 'unknown'
                          CHECK (sentiment IN ('positive', 'neutral', 'negative', 'mixed', 'unknown')),
      satisfaction        VARCHAR(16) NOT NULL DEFAULT 'unknown'
                          CHECK (satisfaction IN ('satisfied', 'neutral', 'dissatisfied', 'unknown')),
      health              VARCHAR(16) NOT NULL DEFAULT 'healthy'
                          CHECK (health IN ('healthy', 'watch', 'at_risk')),
      needs               JSONB NOT NULL DEFAULT '[]',
      objections          JSONB NOT NULL DEFAULT '[]',
      current_issues      JSONB NOT NULL DEFAULT '[]',
      manual_lock_fields  TEXT[] NOT NULL DEFAULT '{}',
      last_observation_id UUID REFERENCES de_customer_observations(id) ON DELETE SET NULL,
      last_confirmed_at   TIMESTAMPTZ,
      version             INTEGER NOT NULL DEFAULT 1,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, profile_id, product_key)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_de_product_states_user_profile
      ON de_customer_product_states (user_id, profile_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_de_product_states_health
      ON de_customer_product_states (user_id, health, updated_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_customer_state_changes (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id              VARCHAR(100) NOT NULL,
      profile_id           UUID NOT NULL REFERENCES de_customer_profiles(id) ON DELETE CASCADE,
      product_state_id     UUID REFERENCES de_customer_product_states(id) ON DELETE SET NULL,
      source_observation_id UUID REFERENCES de_customer_observations(id) ON DELETE SET NULL,
      source_extraction_id UUID REFERENCES de_customer_observation_extractions(id) ON DELETE SET NULL,
      actor_type           VARCHAR(20) NOT NULL CHECK (actor_type IN ('user', 'ai_confirmed', 'system')),
      before_state         JSONB NOT NULL DEFAULT '{}',
      patch                JSONB NOT NULL DEFAULT '{}',
      after_state          JSONB NOT NULL DEFAULT '{}',
      reason               TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_de_state_changes_user_profile_time
      ON de_customer_state_changes (user_id, profile_id, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_customer_capture_drafts (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               VARCHAR(100) NOT NULL,
      conversation_id       UUID REFERENCES conversations(id) ON DELETE SET NULL,
      source_message_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
      raw_text              TEXT NOT NULL,
      candidate_profile_ids JSONB NOT NULL DEFAULT '[]',
      proposed_observation  JSONB NOT NULL DEFAULT '{}',
      ambiguities           JSONB NOT NULL DEFAULT '[]',
      status                VARCHAR(24) NOT NULL
                            CHECK (status IN ('prepared', 'awaiting_confirmation', 'applied', 'rejected', 'expired')),
      applied_profile_id    UUID REFERENCES de_customer_profiles(id) ON DELETE SET NULL,
      applied_observation_id UUID REFERENCES de_customer_observations(id) ON DELETE SET NULL,
      expires_at            TIMESTAMPTZ NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_de_capture_drafts_user_status_expiry
      ON de_customer_capture_drafts (user_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_de_capture_drafts_source_message
      ON de_customer_capture_drafts (user_id, source_message_id);
  `);

  // Keep only mutable projection/draft timestamps automatic. Observations and
  // state-change records are immutable audit facts and deliberately have no
  // update trigger.
  await client.query(`
    CREATE OR REPLACE FUNCTION de_set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_profiles_updated_at') THEN
        CREATE TRIGGER trg_de_profiles_updated_at BEFORE UPDATE ON de_customer_profiles
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_product_states_updated_at') THEN
        CREATE TRIGGER trg_de_product_states_updated_at BEFORE UPDATE ON de_customer_product_states
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_capture_drafts_updated_at') THEN
        CREATE TRIGGER trg_de_capture_drafts_updated_at BEFORE UPDATE ON de_customer_capture_drafts
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
    END $$;
  `);
}

export const digitalEmployeeProfile: Migration = {
  version: 4,
  name: "digital-employee-customer-profile",
  up,
};
