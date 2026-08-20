import type { Migration, QueryClient } from "../migration-runner.js";

/** Conversation drafts, single-customer outreach versions, and campaign results. */
async function up(client: QueryClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS de_conversation_action_drafts (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            VARCHAR(100) NOT NULL,
      conversation_id    UUID REFERENCES conversations(id) ON DELETE SET NULL,
      source_message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
      feature_scope      VARCHAR(64) NOT NULL,
      kind               VARCHAR(64) NOT NULL,
      payload            JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
      preview            JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(preview) = 'object'),
      question           TEXT,
      options            JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options) = 'array'),
      status             VARCHAR(24) NOT NULL DEFAULT 'awaiting_confirmation'
                         CHECK (status IN ('prepared', 'awaiting_confirmation', 'applied', 'expired')),
      applied_entity_id  TEXT,
      expires_at         TIMESTAMPTZ NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_de_conversation_action_drafts_user_kind
      ON de_conversation_action_drafts (user_id, kind, status, expires_at);

    CREATE TABLE IF NOT EXISTS de_outreach_drafts (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          VARCHAR(100) NOT NULL,
      profile_id       UUID NOT NULL REFERENCES de_customer_profiles(id) ON DELETE CASCADE,
      task_id          UUID REFERENCES de_follow_up_tasks(id) ON DELETE SET NULL,
      opportunity_id   UUID REFERENCES de_follow_up_suggestions(id) ON DELETE SET NULL,
      parent_id        UUID REFERENCES de_outreach_drafts(id) ON DELETE SET NULL,
      channel          VARCHAR(32) NOT NULL DEFAULT 'wechat',
      objective        TEXT NOT NULL DEFAULT '',
      content          TEXT NOT NULL,
      alternatives     JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(alternatives) = 'array'),
      source           VARCHAR(24) NOT NULL DEFAULT 'generated'
                       CHECK (source IN ('generated', 'rewrite', 'manual')),
      version          INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      used_at          TIMESTAMPTZ,
      input_snapshot   JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(input_snapshot) = 'object'),
      model_id         VARCHAR(160),
      prompt_version   VARCHAR(80) NOT NULL DEFAULT 'individual-outreach/v1',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_de_outreach_drafts_user_profile
      ON de_outreach_drafts (user_id, profile_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS de_campaign_results (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        VARCHAR(100) NOT NULL,
      campaign_id    UUID NOT NULL REFERENCES de_marketing_campaigns(id) ON DELETE CASCADE,
      impressions    INTEGER CHECK (impressions IS NULL OR impressions >= 0),
      interactions   INTEGER CHECK (interactions IS NULL OR interactions >= 0),
      conversions    INTEGER CHECK (conversions IS NULL OR conversions >= 0),
      leads          INTEGER CHECK (leads IS NULL OR leads >= 0),
      note           TEXT NOT NULL DEFAULT '',
      recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_de_campaign_results_user_recorded
      ON de_campaign_results (user_id, recorded_at DESC);
  `);

  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_conversation_action_drafts_updated_at') THEN
        CREATE TRIGGER trg_de_conversation_action_drafts_updated_at
          BEFORE UPDATE ON de_conversation_action_drafts
          FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_outreach_drafts_updated_at') THEN
        CREATE TRIGGER trg_de_outreach_drafts_updated_at
          BEFORE UPDATE ON de_outreach_drafts
          FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
    END $$;
  `);
}

export const conversationWorkflows: Migration = {
  version: 14,
  name: "digital-employee-conversation-workflows",
  up,
};
