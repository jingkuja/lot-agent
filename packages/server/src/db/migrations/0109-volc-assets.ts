import type { Migration } from "../migration-runner.js";

export const volcAssets: Migration = {
  version: 109,
  name: "volc-assets",
  async up(client) {
    await client.query(`
      CREATE TABLE volc_asset_groups (
        owner_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        remote_id TEXT,
        creating BOOLEAN NOT NULL DEFAULT false,
        check_requested BOOLEAN NOT NULL DEFAULT true,
        run_after TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE volc_assets (
        asset_id UUID NOT NULL,
        owner_id TEXT NOT NULL,
        group_id TEXT,
        remote_id TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'creating', 'processing', 'active', 'failed')),
        deleted BOOLEAN NOT NULL DEFAULT false,
        run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (asset_id, owner_id)
      );

      CREATE INDEX volc_assets_pending_idx ON volc_assets (run_after, owner_id)
        WHERE deleted OR state NOT IN ('active', 'failed');
      CREATE INDEX volc_assets_remote_id_idx ON volc_assets (remote_id) WHERE remote_id IS NOT NULL;
      CREATE INDEX volc_asset_groups_pending_idx ON volc_asset_groups (run_after) WHERE check_requested;

      CREATE FUNCTION sync_volc_asset() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP IN ('DELETE', 'UPDATE') THEN
          IF TG_OP = 'UPDATE' AND OLD.user_id = NEW.user_id THEN
            RETURN NULL;
          END IF;
          -- Keep the job after local deletion so the remote ID (or an in-flight write) can be cleaned up.
          UPDATE volc_assets SET deleted=true, run_after=now()
          WHERE asset_id=OLD.id AND owner_id=OLD.user_id;
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
          IF NEW.type='upload' AND NEW.mime SIMILAR TO '(image|video|audio)/%' THEN
            INSERT INTO volc_assets (asset_id, owner_id) VALUES (NEW.id, NEW.user_id)
            ON CONFLICT (asset_id, owner_id) DO UPDATE SET deleted=false, run_after=now();
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$;

      CREATE TRIGGER sync_volc_asset AFTER INSERT OR DELETE OR UPDATE OF user_id ON assets
        FOR EACH ROW EXECUTE FUNCTION sync_volc_asset();
    `);
  },
};
