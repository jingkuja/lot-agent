import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ComicDramaError, PgComicDramaRepository } from "./repository.js";

const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const makeUuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type StoredDrama = {
  id: string;
  ownerId: string;
  title: string;
  synopsis: string;
  outline: string;
  scriptContent: string;
  styleKey: string;
  aspectRatio: "9:16" | "16:9" | "1:1";
  videoModel: string | null;
  revision: number;
  archivedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type StoredEpisode = {
  id: string;
  ownerId: string;
  dramaId: string;
  parentId: string | null;
  title: string;
  logline: string;
  seriesGroup: string | null;
  episodeNo: number;
  styleKey: string;
  aspectRatio: "9:16" | "16:9" | "1:1";
  videoModel: string | null;
  revision: number;
  archivedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createHierarchyPool() {
  let seq = 1;
  let tick = 0;
  const nextDate = () => new Date(Date.UTC(2026, 10, 25, 10, 0, ++tick));
  const dramas = new Map<string, StoredDrama>();
  const episodes = new Map<string, StoredEpisode>();
  const clips = new Map<string, { id: string; seriesId: string; ordinal: number; revision: number; draft: unknown }>();
  const castRows: Array<{ ownerId: string; seriesId: string; characterId: string; outfitId: string | null; snapshot: unknown }> = [];
  const dramaCastRows: Array<{ ownerId: string; dramaId: string; characterId: string; outfitId: string; snapshot: unknown }> = [];
  const scripts: Array<{ seriesId: string; version: number; content: string; source: string }> = [];
  const currentSeries = new Map<string, string | null>();
  const currentDrama = new Map<string, string | null>();
  const editTasks = new Map<string, { id: string; ownerId: string; dramaId: string; lastSeriesId: string | null }>();
  const projectDrama = (d: StoredDrama) => ({
    id: d.id,
    title: d.title,
    synopsis: d.synopsis,
    outline: d.outline,
    scriptContent: d.scriptContent,
    styleKey: d.styleKey,
    aspectRatio: d.aspectRatio,
    videoModel: d.videoModel,
    revision: d.revision,
    archivedAt: d.archivedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  });
  const projectEpisode = (ep: StoredEpisode) => ({
    id: ep.id,
    dramaId: ep.dramaId,
    parentId: ep.parentId,
    title: ep.title,
    logline: ep.logline,
    seriesGroup: ep.seriesGroup,
    episodeNo: ep.episodeNo,
    styleKey: ep.styleKey,
    aspectRatio: ep.aspectRatio,
    videoModel: ep.videoModel,
    revision: ep.revision,
    archivedAt: ep.archivedAt,
  });

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("BEGIN ISOLATION")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM lot_comic_drama.cd_dictionary")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO lot_comic_drama.cd_dramas")) {
      const id = makeUuid(seq++);
      const now = nextDate();
      const hasPrep = sql.includes("outline,script_content");
      const row: StoredDrama = {
        id,
        ownerId: String(params[0]),
        title: String(params[1]),
        synopsis: String(params[2] ?? ""),
        outline: hasPrep ? String(params[3] ?? "") : "",
        scriptContent: hasPrep ? String(params[4] ?? "") : "",
        styleKey: String(params[hasPrep ? 5 : 3]),
        aspectRatio: params[hasPrep ? 6 : 4] as StoredDrama["aspectRatio"],
        videoModel: (params[hasPrep ? 7 : 5] as string | null) ?? null,
        revision: 1,
        archivedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      dramas.set(id, row);
      return { rows: [projectDrama(row)], rowCount: 1 };
    }
    if (sql.includes("FROM lot_comic_drama.cd_dramas WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL")) {
      const hit = dramas.get(String(params[1]));
      if (!hit || hit.ownerId !== String(params[0]) || hit.deletedAt) return { rows: [], rowCount: 0 };
      if (sql.includes("archived_at IS NULL") && hit.archivedAt) return { rows: [], rowCount: 0 };
      return { rows: [projectDrama(hit)], rowCount: 1 };
    }
    if (sql.startsWith("SELECT revision FROM lot_comic_drama.cd_dramas WHERE owner_id=$1 AND id=$2")) {
      const hit = dramas.get(String(params[1]));
      if (!hit || hit.ownerId !== String(params[0]) || hit.deletedAt) return { rows: [], rowCount: 0 };
      return { rows: [{ revision: hit.revision }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE lot_comic_drama.cd_dramas SET updated_at=clock_timestamp()")) {
      const hit = dramas.get(String(params[1]));
      if (hit && hit.ownerId === String(params[0])) hit.updatedAt = nextDate();
      return { rows: [], rowCount: hit ? 1 : 0 };
    }
    if (sql.includes("UPDATE lot_comic_drama.cd_dramas") && sql.includes("SET outline=$2")) {
      const hit = dramas.get(String(params[0]));
      if (!hit) return { rows: [], rowCount: 0 };
      hit.outline = String(params[1] ?? "");
      hit.revision += 1;
      hit.updatedAt = nextDate();
      return { rows: [projectDrama(hit)], rowCount: 1 };
    }
    if (sql.includes("UPDATE lot_comic_drama.cd_dramas") && sql.includes("SET script_content=$2")) {
      const hit = dramas.get(String(params[0]));
      if (!hit) return { rows: [], rowCount: 0 };
      hit.scriptContent = String(params[1] ?? "");
      hit.revision += 1;
      hit.updatedAt = nextDate();
      return { rows: [projectDrama(hit)], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE lot_comic_drama.cd_dramas\n")) {
      const hit = dramas.get(String(params[0]));
      if (!hit) return { rows: [], rowCount: 0 };
      hit.title = String(params[1]);
      hit.synopsis = String(params[2]);
      hit.outline = String(params[3] ?? hit.outline);
      hit.scriptContent = String(params[4] ?? hit.scriptContent);
      hit.styleKey = String(params[5]);
      hit.aspectRatio = params[6] as StoredDrama["aspectRatio"];
      hit.videoModel = (params[7] as string | null) ?? null;
      hit.revision += 1;
      hit.updatedAt = nextDate();
      return { rows: [projectDrama(hit)], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE lot_comic_drama.cd_dramas SET archived_at=now()") ||
        sql.startsWith("UPDATE lot_comic_drama.cd_dramas SET deleted_at=now()")) {
      const hit = dramas.get(String(params[0]));
      if (hit) {
        if (sql.includes("archived_at=now()")) hit.archivedAt = nextDate();
        else hit.deletedAt = nextDate();
        hit.revision += 1;
        hit.updatedAt = nextDate();
      }
      return { rows: [], rowCount: hit ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE lot_comic_drama.cd_series SET series_group=$3")) {
      const owner = String(params[0]);
      const dramaId = String(params[1]);
      const group = String(params[2]);
      for (const ep of episodes.values()) {
        if (ep.ownerId === owner && ep.dramaId === dramaId && !ep.deletedAt) {
          ep.seriesGroup = group;
          ep.updatedAt = nextDate();
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE lot_comic_drama.cd_series SET archived_at=coalesce") ||
        sql.startsWith("UPDATE lot_comic_drama.cd_series SET deleted_at=coalesce")) {
      const owner = String(params[0]);
      const dramaId = String(params[1]);
      const now = nextDate();
      for (const ep of episodes.values()) {
        if (ep.ownerId === owner && ep.dramaId === dramaId && !ep.deletedAt) {
          if (sql.includes("archived_at=")) ep.archivedAt ??= now;
          else ep.deletedAt ??= now;
          ep.revision += 1;
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('coalesce(max(episode_no),0)::int AS "maxNo"')) {
      const owner = String(params[0]);
      const dramaId = String(params[1]);
      let maxNo = 0;
      for (const ep of episodes.values()) {
        if (ep.ownerId === owner && ep.dramaId === dramaId && !ep.deletedAt) {
          maxNo = Math.max(maxNo, ep.episodeNo);
        }
      }
      return { rows: [{ maxNo }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO lot_comic_drama.cd_series\n")) {
      const id = makeUuid(seq++);
      const now = nextDate();
      const row: StoredEpisode = {
        id,
        ownerId: String(params[0]),
        dramaId: String(params[1]),
        parentId: (params[2] as string | null) ?? null,
        title: String(params[3]),
        logline: String(params[4] ?? ""),
        seriesGroup: (params[5] as string | null) ?? null,
        episodeNo: Number(params[6] ?? 1),
        styleKey: String(params[7]),
        aspectRatio: params[8] as StoredEpisode["aspectRatio"],
        videoModel: (params[9] as string | null) ?? null,
        revision: 1,
        archivedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      episodes.set(id, row);
      return { rows: [projectEpisode(row)], rowCount: 1 };
    }
    if (sql.includes("FROM lot_comic_drama.cd_series WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL")) {
      const hit = episodes.get(String(params[1]));
      if (!hit || hit.ownerId !== String(params[0]) || hit.deletedAt) return { rows: [], rowCount: 0 };
      if (sql.includes("archived_at IS NULL") && hit.archivedAt) return { rows: [], rowCount: 0 };
      return { rows: [projectEpisode(hit)], rowCount: 1 };
    }
    if (sql.includes("FROM lot_comic_drama.cd_series s") && sql.includes("s.drama_id=$2")) {
      const owner = String(params[0]);
      const dramaId = String(params[1]);
      const includeArchived = Boolean(params[2]);
      const matched = [...episodes.values()]
        .filter(ep => ep.ownerId === owner && ep.dramaId === dramaId && !ep.deletedAt && (includeArchived || !ep.archivedAt))
        .sort((a, b) => a.episodeNo - b.episodeNo || a.id.localeCompare(b.id))
        .map(ep => {
          const epClips = [...clips.values()].filter(c => c.seriesId === ep.id);
          return {
            id: ep.id,
            dramaId: ep.dramaId,
            episodeNo: ep.episodeNo,
            title: ep.title,
            logline: ep.logline,
            revision: ep.revision,
            archivedAt: ep.archivedAt,
            updatedAt: ep.updatedAt,
            clipCount: epClips.length,
            completedCount: 0,
            generatingCount: 0,
            hasRender: false,
            coverMediaId: null,
            hasTakes: false,
          };
        });
      return { rows: matched, rowCount: matched.length };
    }
    if (sql.includes("FROM lot_comic_drama.cd_series s") && sql.includes("ANY($2::uuid[])")) {
      const owner = String(params[0]);
      const dramaIds = new Set(params[1] as string[]);
      const archived = Boolean(params[2]);
      const matched = [...episodes.values()]
        .filter(ep => ep.ownerId === owner && dramaIds.has(ep.dramaId) && !ep.deletedAt && (archived || !ep.archivedAt))
        .sort((a, b) => a.episodeNo - b.episodeNo)
        .map(ep => ({
          id: ep.id,
          dramaId: ep.dramaId,
          episodeNo: ep.episodeNo,
          title: ep.title,
          logline: ep.logline,
          revision: ep.revision,
          archivedAt: ep.archivedAt,
          updatedAt: ep.updatedAt,
          clipCount: [...clips.values()].filter(c => c.seriesId === ep.id).length,
          completedCount: 0,
          generatingCount: 0,
          hasRender: false,
          coverMediaId: null,
          hasTakes: false,
        }));
      return { rows: matched, rowCount: matched.length };
    }
    if (sql.includes("WITH ep_stats AS")) {
      const owner = String(params[0]);
      const archived = Boolean(params[1]);
      const q = String(params[2] ?? "").toLowerCase();
      const matched = [...dramas.values()]
        .filter(d => d.ownerId === owner && !d.deletedAt && Boolean(d.archivedAt) === archived)
        .filter(d => !q || d.title.toLowerCase().includes(q) || d.synopsis.toLowerCase().includes(q) ||
          [...episodes.values()].some(ep => ep.dramaId === d.id && !ep.deletedAt && ep.title.toLowerCase().includes(q)))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map(d => ({
          ...projectDrama(d),
          episodeCount: [...episodes.values()].filter(
            ep => ep.ownerId === owner && ep.dramaId === d.id && !ep.deletedAt && (archived || !ep.archivedAt),
          ).length,
          exportedEpisodeCount: 0,
          hasInProgressEpisode: false,
        }));
      return { rows: matched, rowCount: matched.length };
    }
    if (sql.includes("SELECT current_series_id AS \"seriesId\", current_drama_id AS \"dramaId\"")) {
      const owner = String(params[0]);
      return {
        rows: [{ seriesId: currentSeries.get(owner) ?? null, dramaId: currentDrama.get(owner) ?? null }],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT drama_id AS \"dramaId\" FROM lot_comic_drama.cd_series")) {
      const ep = episodes.get(String(params[1]));
      if (!ep || ep.ownerId !== String(params[0]) || ep.deletedAt || ep.archivedAt) return { rows: [], rowCount: 0 };
      return { rows: [{ dramaId: ep.dramaId }], rowCount: 1 };
    }
    if (sql.includes("AS \"episodeCount\"") && sql.includes("AS \"castCount\"") && !sql.includes("WITH ep_stats AS")) {
      const owner = String(params[0]);
      const dramaId = String(params[1]);
      const episodeCount = [...episodes.values()].filter(
        ep => ep.ownerId === owner && ep.dramaId === dramaId && !ep.deletedAt && !ep.archivedAt,
      ).length;
      const castCount = dramaCastRows.filter(c => c.ownerId === owner && c.dramaId === dramaId).length;
      return { rows: [{ episodeCount, castCount }], rowCount: 1 };
    }
    if (sql.includes("SELECT count(*)::int AS n FROM lot_comic_drama.cd_drama_cast")) {
      const owner = String(params[0]);
      const dramaId = String(params[1]);
      return { rows: [{ n: dramaCastRows.filter(c => c.ownerId === owner && c.dramaId === dramaId).length }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO lot_comic_drama.cd_user_state")) {
      const owner = String(params[0]);
      if (sql.includes("VALUES ($1,NULL,$2)")) {
        currentSeries.set(owner, null);
        currentDrama.set(owner, String(params[1]));
      } else {
        const sId = String(params[1]);
        currentSeries.set(owner, sId);
        const dId = (params[2] as string | null) ?? episodes.get(sId)?.dramaId ?? null;
        if (dId) currentDrama.set(owner, dId);
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE lot_comic_drama.cd_user_state") && sql.includes("current_drama_id")) {
      const owner = String(params[0]);
      const dramaId = String(params[1]);
      const cur = currentSeries.get(owner);
      if (cur && episodes.get(cur)?.dramaId === dramaId) currentSeries.set(owner, null);
      if (currentDrama.get(owner) === dramaId) currentDrama.set(owner, null);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO lot_comic_drama.cd_series_cast") && sql.includes("FROM lot_comic_drama.cd_drama_cast")) {
      const targetSeriesId = String(params[0]);
      const owner = String(params[1]);
      const dramaId = String(params[2]);
      let inserted = 0;
      for (const item of dramaCastRows.filter(c => c.ownerId === owner && c.dramaId === dramaId)) {
        if (!castRows.some(c => c.seriesId === targetSeriesId && c.characterId === item.characterId)) {
          castRows.push({ ...item, seriesId: targetSeriesId });
          inserted += 1;
        }
      }
      return { rows: [], rowCount: inserted };
    }
    if (sql.startsWith("INSERT INTO lot_comic_drama.cd_series_cast")) {
      const targetSeriesId = String(params[0]);
      const owner = String(params[1]);
      const sourceSeriesId = String(params[2]);
      const inherited = castRows.filter(c => c.ownerId === owner && c.seriesId === sourceSeriesId);
      for (const item of inherited) castRows.push({ ...item, seriesId: targetSeriesId });
      return { rows: [], rowCount: inherited.length };
    }
    if (sql.startsWith("INSERT INTO lot_comic_drama.cd_scripts")) {
      const seriesId = String(params[0]);
      const content = String(params[1]);
      scripts.push({ seriesId, version: 1, content, source: "user" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE lot_comic_drama.cd_series SET revision=revision+1")) {
      const ep = episodes.get(String(params[0]));
      if (ep) {
        ep.revision += 1;
        return { rows: [{ revision: ep.revision, dramaId: ep.dramaId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM lot_comic_drama.cd_clips WHERE series_id=$1 ORDER BY ordinal")) {
      const sId = String(params[0]);
      const rows = [...clips.values()]
        .filter(c => c.seriesId === sId)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map(c => ({ id: c.id, episodeId: c.seriesId, revision: c.revision, selectionRevision: 1, ordinal: c.ordinal, draft: c.draft }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM lot_comic_drama.cd_scripts WHERE series_id=$1")) {
      const sId = String(params[0]);
      const hit = scripts.filter(s => s.seriesId === sId).sort((a, b) => b.version - a.version)[0];
      return hit ? { rows: [{ version: hit.version, content: hit.content }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM lot_comic_drama.cd_series_cast")) {
      const sId = String(params[0]);
      const rows = castRows
        .filter(c => c.seriesId === sId)
        .map(c => ({ snapshot: c.snapshot, archived: false, hasUpdates: false }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM lot_comic_drama.cd_drama_cast")) {
      const dId = String(params[0]);
      const rows = dramaCastRows
        .filter(c => c.dramaId === dId)
        .map(c => ({ snapshot: c.snapshot, archived: false, hasUpdates: false }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM lot_comic_drama.cd_clips c")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT count(DISTINCT t.target_id)::int AS generating")) return { rows: [{ generating: 0 }], rowCount: 1 };
    if (sql.includes("FROM lot_comic_drama.cd_takes t")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO lot_comic_drama.cd_edit_tasks")) {
      const owner = String(params[0]);
      const dramaId = String(params[1]);
      const lastSeriesId = (params[2] as string | null) ?? null;
      const existing = editTasks.get(dramaId);
      if (existing) {
        existing.lastSeriesId ??= lastSeriesId;
      } else {
        editTasks.set(dramaId, { id: makeUuid(seq++), ownerId: owner, dramaId, lastSeriesId });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE lot_comic_drama.cd_edit_tasks SET last_series_id=NULL")) {
      const owner = String(params[0]);
      if (params.length === 3) {
        const dramaId = String(params[1]);
        const seriesId = String(params[2]);
        const task = editTasks.get(dramaId);
        if (task && task.ownerId === owner && task.lastSeriesId === seriesId) task.lastSeriesId = null;
      } else {
        const seriesId = String(params[1]);
        for (const task of editTasks.values()) {
          if (task.ownerId === owner && task.lastSeriesId === seriesId) task.lastSeriesId = null;
        }
      }
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in hierarchy mock: ${sql}`);
  });

  const client: PoolClient = { query, release: vi.fn() } as unknown as PoolClient;
  const pool: Pool = { connect: vi.fn(async () => client), query } as unknown as Pool;
  return { pool, dramas, episodes, clips, castRows, dramaCastRows, scripts, currentSeries, currentDrama, editTasks };
}

describe("PgComicDramaRepository 3-tier hierarchy", () => {
  it("creates drama -> episodes -> clips, syncs drama renames, and cascades archive/remove", async () => {
    const store = createHierarchyPool();
    const repo = new PgComicDramaRepository(store.pool);

    const created = await repo.createDrama(ownerId, {
      title: "雨夜便利店",
      synopsis: "都会夜归人的奇幻故事",
      styleKey: "thick_painting",
      aspectRatio: "9:16",
      videoModel: null,
      firstEpisodeTitle: "第一夜：风铃",
    });

    expect(created.drama.title).toBe("雨夜便利店");
    expect(created.detail?.series.dramaId).toBe(created.drama.id);
    expect(created.detail?.series.episodeNo).toBe(1);
    expect(created.detail?.hierarchy?.drama.episodeCount).toBe(1);
    expect(store.editTasks.get(created.drama.id)).toMatchObject({
      ownerId,
      dramaId: created.drama.id,
      lastSeriesId: created.detail?.series.id,
    });

    const ep2 = await repo.createEpisode(ownerId, created.drama.id, {
      title: "第二夜：热咖啡",
      sourceSeriesId: created.detail!.series.id,
      inheritCastAndStyle: true,
    });
    expect(ep2.series.episodeNo).toBe(2);
    expect(ep2.series.parentId).toBe(created.detail!.series.id);
    expect(ep2.episodes?.map(e => e.episodeNo)).toEqual([1, 2]);
    expect(store.currentSeries.get(ownerId)).toBe(ep2.series.id);

    // Seed a clip in Episode 2 and read back Tier-3 hierarchy attribution
    const clipId = makeUuid(900);
    store.clips.set(clipId, {
      id: clipId,
      seriesId: ep2.series.id,
      ordinal: 1,
      revision: 1,
      draft: {
        schemaVersion: 1,
        durationMs: 4000,
        scene: "咖啡机特写",
        shots: [{ id: makeUuid(901), framingKey: "closeup", movementKey: "fixed", description: "特写", durationShare: 100 }],
        lines: [],
      },
    });

    const ep2Detail = await repo.get(ownerId, ep2.series.id);
    expect(ep2Detail.drama?.title).toBe("雨夜便利店");
    expect(ep2Detail.summary?.dramaTitle).toBe("雨夜便利店");
    expect(ep2Detail.summary?.episodeNo).toBe(2);
    expect(ep2Detail.summary?.episodeCount).toBe(2);
    expect(ep2Detail.clips[0]?.dramaId).toBe(created.drama.id);
    expect(ep2Detail.clips[0]?.episodeId).toBe(ep2.series.id);
    expect(ep2Detail.hierarchy?.drama.title).toBe("雨夜便利店");
    expect(ep2Detail.hierarchy?.episode.title).toBe("第二夜：热咖啡");
    expect(ep2Detail.hierarchy?.clips[0]?.episodeId).toBe(ep2.series.id);
    expect(ep2Detail.hierarchy?.clips[0]?.scene).toBe("咖啡机特写");

    // Rename Tier-1 drama -> syncs series_group on child episodes & enforces revision check
    await expect(repo.updateDrama(ownerId, created.drama.id, {
      expectedRevision: 99,
      title: "错",
      synopsis: "",
      styleKey: "thick_painting",
      aspectRatio: "9:16",
      videoModel: null,
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" } satisfies Partial<ComicDramaError>);

    const updatedDrama = await repo.updateDrama(ownerId, created.drama.id, {
      expectedRevision: created.drama.revision,
      title: "雨夜便利店·全季",
      synopsis: "重新命名的整部剧",
      styleKey: "thick_painting",
      aspectRatio: "9:16",
      videoModel: null,
    });
    expect(updatedDrama.revision).toBe(2);
    expect(store.episodes.get(ep2.series.id)?.seriesGroup).toBe("雨夜便利店·全季");

    const tree = await repo.listDramas(ownerId, { archived: "false" });
    expect(tree.dramas).toHaveLength(1);
    expect(tree.dramas[0]?.episodeCount).toBe(2);
    expect(tree.dramas[0]?.clipCount).toBe(1);

    // Archive cascades to child episodes and clears current episode pointer
    await repo.archiveDrama(ownerId, created.drama.id, updatedDrama.revision);
    expect(store.currentSeries.get(ownerId)).toBeNull();
    expect(store.episodes.get(ep2.series.id)?.archivedAt).not.toBeNull();

    const archivedTree = await repo.listDramas(ownerId, { archived: "true" });
    expect(archivedTree.dramas).toHaveLength(1);
    expect(archivedTree.dramas[0]?.episodes).toHaveLength(2);

    await repo.removeDrama(ownerId, created.drama.id, updatedDrama.revision + 1);
    const afterDelete = await repo.listDramas(ownerId, { archived: "true" });
    expect(afterDelete.dramas).toHaveLength(0);
  });

  it("supports drama-first preparation (outline, cast, master script) then Episode 1 creation with automatic cast inheritance", async () => {
    const store = createHierarchyPool();
    const repo = new PgComicDramaRepository(store.pool);

    const created = await repo.createDrama(ownerId, {
      title: "长安雨夜",
      synopsis: "盛唐悬疑短剧",
      styleKey: "thick_painting",
      aspectRatio: "9:16",
      videoModel: null,
      createFirstEpisode: false,
    });
    expect(created.detail).toBeNull();
    expect(store.currentDrama.get(ownerId)).toBe(created.drama.id);
    expect(store.currentSeries.get(ownerId)).toBeNull();
    expect(store.editTasks.get(created.drama.id)).toMatchObject({
      ownerId,
      dramaId: created.drama.id,
      lastSeriesId: null,
    });

    const curBefore = await repo.currentDrama(ownerId);
    expect(curBefore.dramaId).toBe(created.drama.id);
    expect(curBefore.seriesId).toBeNull();
    expect(curBefore.episodeCount).toBe(0);

    await expect(repo.saveDramaOutline(ownerId, created.drama.id, 99, "stale")).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    const withOutline = await repo.saveDramaOutline(ownerId, created.drama.id, 1, "全剧大纲：十起雨夜失踪案串联全季。");
    expect(withOutline.outline).toContain("十起雨夜失踪案");
    expect(withOutline.revision).toBe(2);

    const withScript = await repo.saveDramaScript(ownerId, created.drama.id, 2, "【第1集】大理寺灯火通明。");
    expect(withScript.scriptContent).toContain("大理寺灯火通明");
    expect(withScript.revision).toBe(3);

    const charA = makeUuid(501);
    const outfitA = makeUuid(601);
    store.dramaCastRows.push({
      ownerId,
      dramaId: created.drama.id,
      characterId: charA,
      outfitId: outfitA,
      snapshot: {
        schemaVersion: 1,
        characterId: charA,
        name: "沈青",
        aliases: [],
        age: "24",
        personality: "冷静",
        appearance: "青衫折扇",
        roleKey: "lead",
        outfitId: outfitA,
        outfitName: "官服",
        assets: [],
      },
    });

    const ep1 = await repo.createEpisode(ownerId, created.drama.id, {
      title: "第一集：朱雀门雨夜",
      initialScript: "沈青推开木门。",
    });
    expect(ep1.series.episodeNo).toBe(1);
    expect(ep1.script?.content).toBe("沈青推开木门。");
    expect(ep1.cast.map(c => c.snapshot.name)).toEqual(["沈青"]);
    expect(ep1.dramaCastCount).toBe(1);
    expect(store.currentSeries.get(ownerId)).toBe(ep1.series.id);
    expect(store.editTasks.get(created.drama.id)?.lastSeriesId).toBe(ep1.series.id);

    // Add a second drama-level character and sync it into Episode 1
    const charB = makeUuid(502);
    const outfitB = makeUuid(602);
    store.dramaCastRows.push({
      ownerId,
      dramaId: created.drama.id,
      characterId: charB,
      outfitId: outfitB,
      snapshot: {
        schemaVersion: 1,
        characterId: charB,
        name: "苏晚",
        aliases: [],
        age: "22",
        personality: "机敏",
        appearance: "红伞油纸",
        roleKey: "support",
        outfitId: outfitB,
        outfitName: "雨披",
        assets: [],
      },
    });
    const synced = await repo.syncEpisodeCastFromDrama(ownerId, ep1.series.id, ep1.series.revision);
    expect(synced.cast.map(c => c.snapshot.name).sort()).toEqual(["沈青", "苏晚"]);
  });
});
