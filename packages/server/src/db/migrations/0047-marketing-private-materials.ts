import type { Migration } from "../migration-runner.js";

export const marketingPrivateMaterials: Migration = {
  version: 47, name: "marketing-private-materials",
  async up(client) {
    await client.query(`
      ALTER TABLE assets ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT false;
      CREATE INDEX assets_upload_storage_key ON assets(storage_key) WHERE type='upload';
      WITH snapshots AS (
        SELECT user_id, draft->'assets' AS materials FROM marketing_video_projects
        UNION ALL
        SELECT user_id, input->'draft'->'assets' FROM tasks WHERE type='marketing.video'
      ), material_refs AS (
        SELECT user_id, jsonb_array_elements_text(
          CASE jsonb_typeof(item.value)
            WHEN 'array' THEN item.value
            WHEN 'string' THEN jsonb_build_array(item.value)
            ELSE '[]'::jsonb END
        ) AS asset_id
        FROM snapshots CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(materials)='object' THEN materials ELSE '{}'::jsonb END
        ) AS item
      )
      UPDATE assets a SET is_private=true FROM material_refs r
      WHERE a.id::text=lower(r.asset_id) AND a.user_id=r.user_id AND a.type='upload';
    `);
  },
};
