import type { Migration, QueryClient } from "../migration-runner.js";

async function up(client: QueryClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS de_customer_profile_change_drafts (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               VARCHAR(100) NOT NULL,
      conversation_id       UUID REFERENCES conversations(id) ON DELETE SET NULL,
      source_message_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
      operation             VARCHAR(16) NOT NULL CHECK (operation IN ('create', 'update')),
      customer_mention      VARCHAR(200),
      candidate_profile_ids JSONB NOT NULL DEFAULT '[]',
      proposed_patch        JSONB NOT NULL DEFAULT '{}',
      target_version        INTEGER,
      risks                 TEXT[] NOT NULL DEFAULT '{}',
      status                VARCHAR(24) NOT NULL
                            CHECK (status IN ('prepared', 'awaiting_confirmation', 'applied', 'expired')),
      applied_profile_id    UUID REFERENCES de_customer_profiles(id) ON DELETE SET NULL,
      expires_at            TIMESTAMPTZ NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_de_profile_change_drafts_user_status_expiry
      ON de_customer_profile_change_drafts (user_id, status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_de_profile_change_drafts_source
      ON de_customer_profile_change_drafts (user_id, source_message_id, operation)
      WHERE source_message_id IS NOT NULL;
  `);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_profile_change_drafts_updated_at') THEN
        CREATE TRIGGER trg_de_profile_change_drafts_updated_at
        BEFORE UPDATE ON de_customer_profile_change_drafts
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
    END $$;
  `);
}

export const digitalEmployeeProfileChangeDraft: Migration = {
  version: 5,
  name: "digital-employee-profile-change-draft",
  up,
};
