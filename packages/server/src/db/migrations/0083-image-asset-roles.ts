import type { Migration } from "../migration-runner.js";

/** References follow message writes in the same transaction, including worker completion and local edits. */
export const imageAssetRoles: Migration = {
  version: 83, name: "image-asset-roles",
  async up(client) {
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS material_purpose TEXT NOT NULL DEFAULT 'output'
      CHECK (material_purpose IN ('output','dependency','version'));
      CREATE TABLE IF NOT EXISTS generation_asset_references (
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        asset_id UUID NOT NULL REFERENCES assets(id),
        role TEXT NOT NULL CHECK (role IN ('output','dependency')),
        PRIMARY KEY(message_id,asset_id,role)
      );
      CREATE INDEX IF NOT EXISTS generation_asset_references_asset ON generation_asset_references(asset_id,role)`);
    await client.query(`CREATE OR REPLACE FUNCTION sync_generation_asset_references() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE owner_id TEXT;
      BEGIN
        SELECT user_id::text INTO owner_id FROM conversations WHERE id=NEW.conversation_id;
        -- An old output becomes a version. Other messages' output references still keep it visible.
        UPDATE assets SET material_purpose='version' WHERE type='image' AND material_purpose='output' AND id IN (
          SELECT asset_id FROM generation_asset_references WHERE message_id=NEW.id AND role='output'
        );
        DELETE FROM generation_asset_references WHERE message_id=NEW.id;
        INSERT INTO generation_asset_references(message_id,asset_id,role)
          SELECT DISTINCT NEW.id,a.id,r.role FROM (
            SELECT value #>> '{}' AS url,'output' AS role FROM jsonb_path_query(NEW.metadata,'$.assets[*].url') AS value
            UNION ALL SELECT value #>> '{}','output' FROM jsonb_path_query(NEW.metadata,'$.composites[*].url') AS value
            UNION ALL SELECT value #>> '{}','dependency' FROM jsonb_path_query(NEW.metadata,'$.posters[*].background.url') AS value
            UNION ALL SELECT value #>> '{}','dependency' FROM jsonb_path_query(NEW.metadata,'$.whiteOriginals[*].url') AS value
            UNION ALL SELECT value #>> '{}','dependency' FROM jsonb_path_query(NEW.metadata,'$.composedFrom.urls[*]') AS value
          ) r JOIN assets a ON a.user_id=owner_id AND a.storage_key=substring(r.url FROM '^(?:https?://[^/]+)?/static/(?:assets|uploads)/([a-zA-Z0-9_-]+[.][a-zA-Z0-9]+)(?:[?#].*)?$')
          ON CONFLICT DO NOTHING;
        UPDATE assets SET material_purpose='dependency' WHERE type='image' AND material_purpose='output' AND id IN (
          SELECT asset_id FROM generation_asset_references WHERE message_id=NEW.id AND role='dependency'
        );
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS generation_asset_references_sync ON messages;
      CREATE TRIGGER generation_asset_references_sync AFTER INSERT OR UPDATE OF metadata ON messages
        FOR EACH ROW EXECUTE FUNCTION sync_generation_asset_references()`);
    // Only stored metadata proves an asset's role. Unrecognizable historical outputs stay visible.
    const result = await client.query(`UPDATE messages SET metadata=metadata
      WHERE metadata->>'kind'='generation' AND metadata->>'mediaType'='image'`);
    const counts = await client.query(`SELECT material_purpose,count(*)::int AS count FROM assets GROUP BY material_purpose`);
    console.info("[migration:image-asset-roles] backfill", { messages: result.rowCount, assets: counts.rows });
  },
};
