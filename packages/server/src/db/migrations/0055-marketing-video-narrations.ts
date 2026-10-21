import type { Migration } from "../migration-runner.js";

/** Per-shot twin narration of a marketing draft. The key covers the voice, its settings and
 * the shot text, so an edit leaves the old take unused instead of overwriting it. A row is
 * written as `running` before the billed speech request and never resent automatically. */
export const marketingVideoNarrations: Migration = {
  version: 55, name: "marketing-video-narrations",
  async up(client) {
    await client.query(`CREATE TABLE marketing_video_narrations (
        owner_id VARCHAR(100) NOT NULL,
        project_id UUID NOT NULL REFERENCES marketing_video_projects(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 14),
        narration_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
        storage_key TEXT,
        duration_ms INTEGER CHECK(duration_ms > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(owner_id, project_id, slot, narration_key),
        CHECK(status <> 'succeeded' OR (storage_key IS NOT NULL AND duration_ms IS NOT NULL))
      );`);
  },
};
