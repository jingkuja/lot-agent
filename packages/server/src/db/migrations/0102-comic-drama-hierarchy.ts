import type { Migration } from "../migration-runner.js";

export const comicDramaHierarchy: Migration = {
  version: 102,
  name: "comic-drama-hierarchy",
  async up(client) {
    await client.query(`
      CREATE TABLE lot_comic_drama.cd_dramas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        synopsis TEXT NOT NULL DEFAULT '',
        style_key TEXT NOT NULL DEFAULT 'thick_painting',
        aspect_ratio TEXT NOT NULL DEFAULT '9:16' CHECK (aspect_ratio IN ('9:16','16:9','1:1')),
        video_model TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        archived_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        UNIQUE (owner_id, id)
      );
      CREATE INDEX cd_dramas_owner_updated_idx
        ON lot_comic_drama.cd_dramas(owner_id, updated_at DESC, id DESC)
        WHERE deleted_at IS NULL;

      ALTER TABLE lot_comic_drama.cd_series
        ADD COLUMN drama_id UUID;

      WITH RECURSIVE lineage AS (
        SELECT id, owner_id, parent_id, id AS root_id, title, logline, series_group,
               style_key, aspect_ratio, video_model, created_at, updated_at, archived_at, deleted_at
        FROM lot_comic_drama.cd_series
        WHERE parent_id IS NULL
        UNION ALL
        SELECT child.id, child.owner_id, child.parent_id, parent.root_id, child.title, child.logline,
               child.series_group, child.style_key, child.aspect_ratio, child.video_model,
               child.created_at, child.updated_at, child.archived_at, child.deleted_at
        FROM lot_comic_drama.cd_series child
        JOIN lineage parent ON parent.owner_id = child.owner_id AND parent.id = child.parent_id
      ),
      group_names AS (
        SELECT owner_id, root_id,
               (array_agg(NULLIF(btrim(series_group), '') ORDER BY created_at ASC, id ASC)
                 FILTER (WHERE NULLIF(btrim(series_group), '') IS NOT NULL))[1] AS chain_group
        FROM lineage
        GROUP BY owner_id, root_id
      ),
      classified AS (
        SELECT l.*,
               coalesce(NULLIF(btrim(l.series_group), ''), gn.chain_group) AS effective_group,
               CASE
                 WHEN coalesce(NULLIF(btrim(l.series_group), ''), gn.chain_group) IS NOT NULL
                   THEN 'group:' || coalesce(NULLIF(btrim(l.series_group), ''), gn.chain_group)
                 ELSE 'root:' || l.root_id::text
               END AS bucket_key
        FROM lineage l
        JOIN group_names gn ON gn.owner_id = l.owner_id AND gn.root_id = l.root_id
      ),
      buckets AS (
        SELECT gen_random_uuid() AS drama_id,
               owner_id,
               bucket_key,
               coalesce(
                 max(effective_group),
                 (array_agg(title ORDER BY created_at ASC, id ASC))[1]
               ) AS title,
               coalesce(
                 (array_agg(logline ORDER BY created_at ASC, id ASC) FILTER (WHERE logline <> ''))[1],
                 ''
               ) AS synopsis,
               (array_agg(style_key ORDER BY created_at ASC, id ASC))[1] AS style_key,
               (array_agg(aspect_ratio ORDER BY created_at ASC, id ASC))[1] AS aspect_ratio,
               (array_agg(video_model ORDER BY created_at ASC, id ASC))[1] AS video_model,
               min(created_at) AS created_at,
               max(updated_at) AS updated_at,
               CASE WHEN bool_and(archived_at IS NOT NULL) THEN max(archived_at) ELSE NULL END AS archived_at,
               CASE WHEN bool_and(deleted_at IS NOT NULL) THEN max(deleted_at) ELSE NULL END AS deleted_at
        FROM classified
        GROUP BY owner_id, bucket_key
      ),
      inserted AS (
        INSERT INTO lot_comic_drama.cd_dramas
          (id, owner_id, title, synopsis, style_key, aspect_ratio, video_model, created_at, updated_at, archived_at, deleted_at)
        SELECT drama_id, owner_id, title, synopsis, style_key, aspect_ratio, video_model, created_at, updated_at, archived_at, deleted_at
        FROM buckets
        RETURNING id, owner_id, title
      )
      UPDATE lot_comic_drama.cd_series s
      SET drama_id = b.drama_id,
          series_group = b.title
      FROM classified c
      JOIN buckets b ON b.owner_id = c.owner_id AND b.bucket_key = c.bucket_key
      WHERE s.owner_id = c.owner_id AND s.id = c.id;

      WITH unnumbered AS (
        SELECT s.id, s.owner_id, s.drama_id,
               row_number() OVER (PARTITION BY s.owner_id, s.drama_id ORDER BY s.created_at ASC, s.id ASC) AS rn,
               exists(
                 SELECT 1 FROM lot_comic_drama.cd_series e1
                 WHERE e1.owner_id = s.owner_id AND e1.drama_id = s.drama_id AND e1.episode_no = 1
               ) AS has_ep1,
               coalesce((
                 SELECT max(em.episode_no) FROM lot_comic_drama.cd_series em
                 WHERE em.owner_id = s.owner_id AND em.drama_id = s.drama_id AND em.episode_no IS NOT NULL
               ), 0) AS max_ep
        FROM lot_comic_drama.cd_series s
        WHERE s.episode_no IS NULL
      )
      UPDATE lot_comic_drama.cd_series s
      SET episode_no = CASE
        WHEN NOT u.has_ep1 AND u.rn = 1 THEN 1
        WHEN NOT u.has_ep1 THEN greatest(u.max_ep, 1) + u.rn - 1
        ELSE u.max_ep + u.rn
      END
      FROM unnumbered u
      WHERE s.id = u.id;

      ALTER TABLE lot_comic_drama.cd_series
        ALTER COLUMN drama_id SET NOT NULL,
        ALTER COLUMN episode_no SET DEFAULT 1,
        ALTER COLUMN episode_no SET NOT NULL,
        ADD CONSTRAINT cd_series_drama_fk
          FOREIGN KEY (owner_id, drama_id) REFERENCES lot_comic_drama.cd_dramas(owner_id, id);

      CREATE INDEX cd_series_drama_episode_idx
        ON lot_comic_drama.cd_series(owner_id, drama_id, episode_no ASC, created_at ASC, id ASC)
        WHERE deleted_at IS NULL;
    `);
  },
};
