import type { Migration } from "../migration-runner.js";

export const klingVoiceTasks: Migration = {
  version: 35,
  name: "kling-voice-tasks",
  async up(client) {
    await client.query(`
      CREATE TABLE generation_voice_tasks (
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id VARCHAR(100) NOT NULL,
        slot SMALLINT NOT NULL CHECK (slot BETWEEN 0 AND 1),
        fingerprint TEXT NOT NULL,
        external_task_id TEXT NOT NULL UNIQUE,
        vendor_task_id TEXT,
        voice_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (task_id, slot)
      );
    `);
  },
};
