import type { Migration } from "../migration-runner.js";

export const comicDramaV1Remediation: Migration = {
  version: 97,
  name: "comic-drama-v1-remediation",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_clips
        ADD COLUMN selection_revision INTEGER NOT NULL DEFAULT 1;

      ALTER TABLE lot_comic_drama.cd_takes
        ADD COLUMN settled_amount_micros BIGINT CHECK (settled_amount_micros IS NULL OR settled_amount_micros >= 0),
        ADD COLUMN settled_currency TEXT CHECK (settled_currency IS NULL OR settled_currency IN ('CNY', 'USD')),
        ADD COLUMN settled_at TIMESTAMPTZ,
        ADD COLUMN settled_source TEXT,
        ADD CONSTRAINT cd_takes_settled_pair_check CHECK ((settled_amount_micros IS NULL) = (settled_currency IS NULL));

      ALTER TABLE lot_comic_drama.cd_speech_cache
        ADD COLUMN active_attempt_id UUID,
        ADD COLUMN kind TEXT NOT NULL DEFAULT 'dialogue' CHECK (kind IN ('dialogue', 'audition'));

      CREATE TABLE lot_comic_drama.cd_speech_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('dialogue', 'audition')),
        edit_id UUID REFERENCES lot_comic_drama.cd_edits(id) ON DELETE SET NULL,
        line_id UUID,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('submitting', 'ready', 'failed', 'unknown', 'released')),
        media_id UUID REFERENCES lot_comic_drama.cd_media(id) ON DELETE SET NULL,
        gateway_request_id TEXT,
        gateway_http_status INTEGER,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        released_at TIMESTAMPTZ
      );

      CREATE INDEX cd_speech_attempts_owner_fp_idx
        ON lot_comic_drama.cd_speech_attempts(owner_id, fingerprint, created_at DESC);
      CREATE INDEX cd_speech_attempts_reconcile_idx
        ON lot_comic_drama.cd_speech_attempts(status, updated_at DESC);
    `);
  },
};
