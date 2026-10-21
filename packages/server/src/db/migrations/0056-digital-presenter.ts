import type { Migration } from "../migration-runner.js";

/** Digital presenter drafts, their per-segment voice takes, and the vendor clips of each job.
 * Takes and clips are written as intents before the billed request and never resent
 * automatically; a clip left `submitting` has an unknown outcome until the user releases it. */
export const digitalPresenter: Migration = {
  version: 56, name: "digital-presenter",
  async up(client) {
    await client.query(`
      CREATE TABLE digital_presenter_projects (
        id UUID PRIMARY KEY, user_id VARCHAR(100) NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, draft JSONB NOT NULL,
        review JSONB, reviewed_script TEXT,
        task_id UUID REFERENCES tasks(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX digital_presenter_projects_owner ON digital_presenter_projects(user_id, updated_at DESC);
      CREATE TABLE digital_presenter_takes (
        project_id UUID NOT NULL REFERENCES digital_presenter_projects(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 11),
        take_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
        file TEXT, duration_ms INTEGER CHECK(duration_ms > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(project_id, slot, take_key),
        CHECK(status <> 'succeeded' OR (file IS NOT NULL AND duration_ms IS NOT NULL))
      );
      CREATE TABLE digital_presenter_clips (
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 11),
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitting','running','succeeded','failed')),
        vendor_task_id TEXT, file TEXT, seconds NUMERIC, error TEXT,
        released_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(task_id, slot),
        CHECK(status <> 'succeeded' OR file IS NOT NULL)
      );
    `);
  },
};
