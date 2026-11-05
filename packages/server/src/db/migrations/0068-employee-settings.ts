import type { Migration } from "../migration-runner.js";

/** The employee's name and reminder channels. A row exists only after the owner saves one. */
export const employeeSettings: Migration = {
  version: 68, name: "employee-settings",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS de_employee_settings (
        user_id          VARCHAR(100) PRIMARY KEY,
        employee_name    TEXT NOT NULL CHECK (char_length(employee_name) BETWEEN 1 AND 20),
        feishu_reminder  BOOLEAN NOT NULL DEFAULT false,
        desktop_reminder BOOLEAN NOT NULL DEFAULT false,
        version          INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  },
};
