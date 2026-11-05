import type { Migration } from "../migration-runner.js";

/** Closed choices on purpose: a free-text box would collect customer facts, which belong in business tables. */
export const employeeWorkPreferences: Migration = {
  version: 72, name: "employee-work-preferences",
  async up(client) {
    await client.query(`
      ALTER TABLE de_employee_settings
        ADD COLUMN IF NOT EXISTS work_tone TEXT CHECK (work_tone IN ('warm', 'professional', 'concise', 'lively')),
        ADD COLUMN IF NOT EXISTS preferred_channels TEXT[] NOT NULL DEFAULT '{}';
    `);
  },
};
