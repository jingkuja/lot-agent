import type { Migration } from "../migration-runner.js";

/** Accounts that already opted in keep their model step; everyone else scans by rules only. */
export const discoveryMode: Migration = {
  version: 70, name: "discovery-mode",
  async up(client) {
    await client.query(`
      ALTER TABLE de_follow_up_automation_settings
        ADD COLUMN discovery_mode VARCHAR(16) NOT NULL DEFAULT 'rules' CHECK (discovery_mode IN ('rules', 'hybrid'));
      UPDATE de_follow_up_automation_settings SET discovery_mode = 'hybrid' WHERE enabled = true;
    `);
  },
};
