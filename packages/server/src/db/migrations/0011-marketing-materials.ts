import type { Migration, QueryClient } from "../migration-runner.js";

async function up(client: QueryClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS marketing_products (
      id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                  VARCHAR(100) NOT NULL,
      name                     VARCHAR(200) NOT NULL,
      positioning              TEXT NOT NULL DEFAULT '',
      core_values              TEXT[] NOT NULL DEFAULT '{}',
      verifiable_facts         JSONB NOT NULL DEFAULT '[]'
                               CHECK (jsonb_typeof(verifiable_facts) = 'array'),
      common_objections        JSONB NOT NULL DEFAULT '[]'
                               CHECK (jsonb_typeof(common_objections) = 'array'),
      current_benefits         JSONB NOT NULL DEFAULT '[]'
                               CHECK (jsonb_typeof(current_benefits) = 'array'),
      prohibited_expressions   TEXT[] NOT NULL DEFAULT '{}',
      case_materials           JSONB NOT NULL DEFAULT '[]'
                               CHECK (jsonb_typeof(case_materials) = 'array'),
      status                   VARCHAR(16) NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'archived')),
      version                  INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      archived_at              TIMESTAMPTZ,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_marketing_products_user_status_updated
      ON marketing_products (user_id, status, updated_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_products_user_active_name
      ON marketing_products (user_id, lower(name)) WHERE status = 'active';
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS marketing_brand_assets (
      id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                  VARCHAR(100) NOT NULL UNIQUE,
      tone                     TEXT[] NOT NULL DEFAULT '{}',
      visual_assets            JSONB NOT NULL DEFAULT '[]'
                               CHECK (jsonb_typeof(visual_assets) = 'array'),
      standard_calls_to_action TEXT[] NOT NULL DEFAULT '{}',
      version                  INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_marketing_products_updated_at') THEN
        CREATE TRIGGER trg_marketing_products_updated_at
          BEFORE UPDATE ON marketing_products
          FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_marketing_brand_assets_updated_at') THEN
        CREATE TRIGGER trg_marketing_brand_assets_updated_at
          BEFORE UPDATE ON marketing_brand_assets
          FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
    END $$;
  `);
}

export const marketingMaterials: Migration = {
  version: 11,
  name: "digital-employee-marketing-materials",
  up,
};
