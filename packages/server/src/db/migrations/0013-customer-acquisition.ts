import type { Migration, QueryClient } from "../migration-runner.js";

/**
 * Customer-acquisition (获客宝) owns cohort marketing independently from the
 * single-customer opportunity workflow. The schema keeps dynamic segment
 * definitions, immutable campaign snapshots, generated assets and real-world
 * deployment feedback as separate lifecycle records.
 */
async function up(client: QueryClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS de_customer_segments (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     VARCHAR(100) NOT NULL,
      name        VARCHAR(200) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      criteria    JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(criteria) = 'object'),
      status      VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_de_segments_user_status_updated
      ON de_customer_segments (user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS de_customer_segment_snapshots (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               VARCHAR(100) NOT NULL,
      segment_id            UUID REFERENCES de_customer_segments(id) ON DELETE SET NULL,
      audience_description  TEXT NOT NULL DEFAULT '',
      criteria              JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(criteria) = 'object'),
      profile_ids           UUID[] NOT NULL DEFAULT '{}',
      excluded_profile_ids  UUID[] NOT NULL DEFAULT '{}',
      metrics               JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metrics) = 'object'),
      sampled_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_de_segment_snapshots_user_created
      ON de_customer_segment_snapshots (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_de_segment_snapshots_segment
      ON de_customer_segment_snapshots (user_id, segment_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS de_campaign_opportunities (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id              VARCHAR(100) NOT NULL,
      segment_snapshot_id  UUID NOT NULL REFERENCES de_customer_segment_snapshots(id) ON DELETE CASCADE,
      product_id           UUID REFERENCES marketing_products(id) ON DELETE SET NULL,
      title                VARCHAR(300) NOT NULL,
      objective            TEXT NOT NULL,
      theme                TEXT NOT NULL,
      reasoning            TEXT NOT NULL,
      core_points          JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(core_points) = 'array'),
      suggested_channels   JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(suggested_channels) = 'array'),
      risks                JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(risks) = 'array'),
      priority             VARCHAR(16) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
      status               VARCHAR(16) NOT NULL DEFAULT 'suggested'
                           CHECK (status IN ('suggested', 'accepted', 'dismissed', 'expired')),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS de_marketing_campaigns (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id              VARCHAR(100) NOT NULL,
      segment_snapshot_id  UUID NOT NULL REFERENCES de_customer_segment_snapshots(id) ON DELETE RESTRICT,
      opportunity_id       UUID REFERENCES de_campaign_opportunities(id) ON DELETE SET NULL,
      product_id           UUID REFERENCES marketing_products(id) ON DELETE SET NULL,
      name                 VARCHAR(300) NOT NULL,
      objective            TEXT NOT NULL,
      channels             TEXT[] NOT NULL DEFAULT '{}',
      call_to_action       TEXT NOT NULL DEFAULT '',
      starts_at            TIMESTAMPTZ,
      ends_at              TIMESTAMPTZ,
      status               VARCHAR(16) NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'active', 'completed', 'archived')),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_de_campaigns_user_status_updated
      ON de_marketing_campaigns (user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS de_campaign_briefs (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            VARCHAR(100) NOT NULL,
      campaign_id        UUID NOT NULL UNIQUE REFERENCES de_marketing_campaigns(id) ON DELETE CASCADE,
      snapshot           JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(snapshot) = 'object'),
      product_version    INTEGER,
      brief              JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(brief) = 'object'),
      version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS de_marketing_asset_library (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id              VARCHAR(100) NOT NULL,
      campaign_id          UUID REFERENCES de_marketing_campaigns(id) ON DELETE SET NULL,
      segment_snapshot_id  UUID REFERENCES de_customer_segment_snapshots(id) ON DELETE SET NULL,
      parent_asset_id      UUID REFERENCES de_marketing_asset_library(id) ON DELETE SET NULL,
      task_id              UUID REFERENCES tasks(id) ON DELETE SET NULL,
      asset_type           VARCHAR(20) NOT NULL CHECK (asset_type IN ('text', 'poster', 'image', 'video')),
      title                VARCHAR(500) NOT NULL,
      content              TEXT NOT NULL DEFAULT '',
      file_url             TEXT,
      source               VARCHAR(24) NOT NULL DEFAULT 'workspace'
                           CHECK (source IN ('workspace', 'recommendation', 'reuse')),
      model_id             VARCHAR(160),
      generation_status    VARCHAR(20) NOT NULL DEFAULT 'ready'
                           CHECK (generation_status IN ('pending', 'running', 'ready', 'failed', 'cancelled')),
      status               VARCHAR(16) NOT NULL DEFAULT 'ready' CHECK (status IN ('draft', 'ready', 'archived')),
      version              INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_de_asset_library_user_created
      ON de_marketing_asset_library (user_id, status, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_de_asset_library_campaign
      ON de_marketing_asset_library (user_id, campaign_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS de_campaign_generation_runs (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id              VARCHAR(100) NOT NULL,
      campaign_id          UUID NOT NULL REFERENCES de_marketing_campaigns(id) ON DELETE CASCADE,
      asset_id             UUID REFERENCES de_marketing_asset_library(id) ON DELETE SET NULL,
      task_id              UUID REFERENCES tasks(id) ON DELETE SET NULL,
      model_id             VARCHAR(160) NOT NULL,
      input_snapshot       JSONB NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
      prompt_version       VARCHAR(80) NOT NULL,
      status               VARCHAR(20) NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
      error                TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_de_campaign_runs_user_created
      ON de_campaign_generation_runs (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS de_asset_deployments (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          VARCHAR(100) NOT NULL,
      asset_id         UUID NOT NULL REFERENCES de_marketing_asset_library(id) ON DELETE CASCADE,
      platform         VARCHAR(32) NOT NULL
                       CHECK (platform IN ('moments', 'wechat_official', 'channels', 'douyin_kuaishou', 'xiaohongshu', 'ad_platform', 'other')),
      custom_platform  VARCHAR(100) NOT NULL DEFAULT '',
      deployed_at      TIMESTAMPTZ,
      status           VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deployed', 'ended')),
      created_by       VARCHAR(100) NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, asset_id, platform, custom_platform)
    );
    CREATE INDEX IF NOT EXISTS idx_de_asset_deployments_user_status
      ON de_asset_deployments (user_id, status, deployed_at DESC);

    CREATE TABLE IF NOT EXISTS de_deployment_feedback (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        VARCHAR(100) NOT NULL,
      deployment_id  UUID NOT NULL REFERENCES de_asset_deployments(id) ON DELETE CASCADE,
      impressions    INTEGER CHECK (impressions IS NULL OR impressions >= 0),
      interactions   INTEGER CHECK (interactions IS NULL OR interactions >= 0),
      conversions    INTEGER CHECK (conversions IS NULL OR conversions >= 0),
      feedback_text  TEXT NOT NULL DEFAULT '',
      recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_de_deployment_feedback_user_recorded
      ON de_deployment_feedback (user_id, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS de_daily_recommendations (
      id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                     VARCHAR(100) NOT NULL,
      recommendation_date         DATE NOT NULL,
      recommendation_type         VARCHAR(20) NOT NULL CHECK (recommendation_type IN ('copy', 'poster', 'video_script')),
      segment_id                  UUID REFERENCES de_customer_segments(id) ON DELETE SET NULL,
      product_id                  UUID REFERENCES marketing_products(id) ON DELETE SET NULL,
      target_segment_description  TEXT NOT NULL,
      theme                       VARCHAR(500) NOT NULL,
      core_points                 JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(core_points) = 'array'),
      suggested_channels          JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(suggested_channels) = 'array'),
      reasoning                   JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reasoning) = 'array'),
      creative_direction          TEXT NOT NULL DEFAULT '',
      duration_seconds            INTEGER,
      status                      VARCHAR(16) NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'adopted', 'ignored', 'expired')),
      generated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at                  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
      UNIQUE (user_id, recommendation_date, recommendation_type, theme)
    );
    CREATE INDEX IF NOT EXISTS idx_de_daily_recommendations_user_status_date
      ON de_daily_recommendations (user_id, status, recommendation_date DESC, generated_at DESC);
  `);

  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_segments_updated_at') THEN
        CREATE TRIGGER trg_de_segments_updated_at BEFORE UPDATE ON de_customer_segments
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_campaign_opportunities_updated_at') THEN
        CREATE TRIGGER trg_de_campaign_opportunities_updated_at BEFORE UPDATE ON de_campaign_opportunities
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_campaigns_updated_at') THEN
        CREATE TRIGGER trg_de_campaigns_updated_at BEFORE UPDATE ON de_marketing_campaigns
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_campaign_briefs_updated_at') THEN
        CREATE TRIGGER trg_de_campaign_briefs_updated_at BEFORE UPDATE ON de_campaign_briefs
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_asset_library_updated_at') THEN
        CREATE TRIGGER trg_de_asset_library_updated_at BEFORE UPDATE ON de_marketing_asset_library
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_asset_deployments_updated_at') THEN
        CREATE TRIGGER trg_de_asset_deployments_updated_at BEFORE UPDATE ON de_asset_deployments
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
    END $$;
  `);
}

export const customerAcquisition: Migration = {
  version: 13,
  name: "digital-employee-customer-acquisition",
  up,
};
