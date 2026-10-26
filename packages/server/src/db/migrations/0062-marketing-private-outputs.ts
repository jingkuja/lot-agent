import type { Migration } from "../migration-runner.js";

/** Marketing clips and made videos can show the owner's portrait and cloned voice (T15): they become
 * private like the draft's materials, and /static/assets serves them only to the owner's session or a
 * signed, expiring link. Other generated files stay public. The index serves that per-request lookup. */
export const marketingPrivateOutputs: Migration = {
  version: 62, name: "marketing-private-outputs",
  async up(client) {
    await client.query(`
      CREATE INDEX assets_generated_storage_key ON assets(storage_key) WHERE type<>'upload';
      UPDATE assets a SET is_private=true FROM tasks t
      WHERE a.task_id=t.id AND a.user_id=t.user_id AND t.type IN ('marketing.video','marketing.segment') AND NOT a.is_private;
    `);
  },
};
