import { Hono } from "hono";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ComicTimeline } from "@lot-agent/core/comic-drama";
import { ComicEditConflict, PgComicEdits } from "./edit-repository.js";
import { createComicEditRoutes } from "./edit-routes.js";
import type { ComicEditSpeech } from "./edit-speech.js";

const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("comic-drama drama edit tasks and episode units", () => {
  it("validates drama edit task routes and conflict/protection codes", async () => {
    const dramaId = uuid(1);
    const seriesId = uuid(2);
    const editId = uuid(3);
    const view = {
      task: {
        id: uuid(4), dramaId, dramaTitle: "长安雨夜", synopsis: "", styleKey: "thick_painting",
        aspectRatio: "9:16" as const, archivedAt: null, lastSeriesId: seriesId,
        updatedAt: new Date().toISOString(),
      },
      episodes: [],
      activeSeriesId: seriesId,
      edit: null,
    };
    const getDramaTask = vi.fn(async () => view);
    const openDramaTask = vi.fn(async () => view);
    const syncEpisodeSources = vi.fn(async () => {
      throw new ComicEditConflict(3);
    });
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    app.route("/", createComicEditRoutes(
      { getDramaTask, openDramaTask, syncEpisodeSources } as unknown as PgComicEdits,
      {} as ComicEditSpeech,
    ));

    const badGet = await app.request(`/dramas/${dramaId}/edit?seriesId=not-a-uuid`);
    expect(badGet.status).toBe(400);

    const okGet = await app.request(`/dramas/${dramaId}/edit?seriesId=${seriesId}`);
    expect(okGet.status).toBe(200);
    expect(getDramaTask).toHaveBeenCalledWith(ownerId, dramaId, seriesId);

    const okOpen = await app.request(`/dramas/${dramaId}/edit/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesId }),
    });
    expect(okOpen.status).toBe(200);
    expect(openDramaTask).toHaveBeenCalledWith(ownerId, dramaId, seriesId);

    const badSync = await app.request(`/edits/${editId}/sync-episode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    expect(badSync.status).toBe(400);

    const conflictSync = await app.request(`/edits/${editId}/sync-episode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(conflictSync.status).toBe(409);
    expect(await conflictSync.json()).toEqual({ code: "REVISION_CONFLICT", currentRevision: 3 });
  });

  it("manages drama edit task episode units, auto-seeds empty timelines, syncs adopted clips, and protects from free delete", async () => {
    let seq = 1;
    const dramaId = uuid(10);
    const ep1Id = uuid(11);
    const ep2Id = uuid(12);
    const clip1Id = uuid(21);
    const clip2Id = uuid(22);
    const take1Id = uuid(31);
    const take2Id = uuid(32);
    const media1Id = uuid(41);
    const media2Id = uuid(42);
    const freeEditId = uuid(50);

    type StoredEdit = {
      id: string;
      ownerId: string;
      seriesId: string | null;
      dramaEditTaskId: string | null;
      title: string;
      revision: number;
      timeline: ComicTimeline;
      updatedAt: Date;
    };
    const editTasks = new Map<string, { id: string; ownerId: string; dramaId: string; lastSeriesId: string | null; updatedAt: Date }>();
    const edits = new Map<string, StoredEdit>();
    const episodes = [
      { id: ep1Id, dramaId, episodeNo: 1, title: "第一集", logline: "", aspectRatio: "9:16" as const, archivedAt: null, updatedAt: new Date() },
      { id: ep2Id, dramaId, episodeNo: 2, title: "第二集", logline: "", aspectRatio: "9:16" as const, archivedAt: null, updatedAt: new Date() },
    ];
    const clips = new Map<string, { id: string; seriesId: string; ordinal: number; scene: string; adoptedTakeId: string | null }>([
      [clip1Id, { id: clip1Id, seriesId: ep1Id, ordinal: 1, scene: "分镜一", adoptedTakeId: take1Id }],
      [clip2Id, { id: clip2Id, seriesId: ep1Id, ordinal: 2, scene: "分镜二", adoptedTakeId: null }],
    ]);
    const takes = new Map<string, { takeId: string; mediaId: string; seriesId: string; clipId: string; durationMs: number }>([
      [take1Id, { takeId: take1Id, mediaId: media1Id, seriesId: ep1Id, clipId: clip1Id, durationMs: 4000 }],
      [take2Id, { takeId: take2Id, mediaId: media2Id, seriesId: ep1Id, clipId: clip2Id, durationMs: 5000 }],
    ]);
    let lastEditId: string | null = null;
    edits.set(freeEditId, {
      id: freeEditId, ownerId, seriesId: null, dramaEditTaskId: null, title: "自由混剪",
      revision: 1, timeline: { schemaVersion: 1, aspectRatio: "9:16", video: [], voice: [], sfx: [], music: [], subtitles: [] },
      updatedAt: new Date(),
    });

    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM lot_comic_drama.cd_dramas WHERE owner_id=$1 AND id=$2")) {
        return {
          rows: [{
            id: dramaId, title: "雨夜便利店", synopsis: "", styleKey: "thick_painting",
            aspectRatio: "9:16", archivedAt: null, updatedAt: new Date(),
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("INSERT INTO lot_comic_drama.cd_edit_tasks")) {
        if (!editTasks.has(dramaId)) {
          editTasks.set(dramaId, { id: uuid(900 + seq++), ownerId, dramaId, lastSeriesId: null, updatedAt: new Date() });
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM lot_comic_drama.cd_edit_tasks WHERE owner_id=$1 AND drama_id=$2")) {
        const t = editTasks.get(dramaId);
        return { rows: t ? [t] : [], rowCount: t ? 1 : 0 };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_edit_tasks SET last_series_id=$3")) {
        const t = editTasks.get(dramaId);
        if (t) t.lastSeriesId = String(params[2]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_edit_tasks SET updated_at=")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM lot_comic_drama.cd_series s") && sql.includes("JOIN lot_comic_drama.cd_edit_tasks et")) {
        const task = editTasks.get(dramaId);
        const rows = episodes.map(ep => {
          const ed = [...edits.values()].find(item => item.dramaEditTaskId === task?.id && item.seriesId === ep.id);
          return {
            seriesId: ep.id, dramaId: ep.dramaId, episodeNo: ep.episodeNo, title: ep.title, logline: ep.logline,
            aspectRatio: ep.aspectRatio, archivedAt: ep.archivedAt, seriesUpdatedAt: ep.updatedAt,
            editId: ed?.id ?? null, editRevision: ed?.revision ?? null, timeline: ed?.timeline ?? null,
            editUpdatedAt: ed?.updatedAt ?? null, renderCount: 0, hasReadyRender: false,
          };
        });
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM lot_comic_drama.cd_clips c") && sql.includes("ANY($2::uuid[])")) {
        const sIds = new Set(params[1] as string[]);
        const rows = [...clips.values()]
          .filter(c => sIds.has(c.seriesId))
          .map(c => ({
            seriesId: c.seriesId, clipId: c.id, ordinal: c.ordinal, scene: c.scene,
            adoptedTakeId: c.adoptedTakeId,
            adoptedDurationMs: c.adoptedTakeId ? (takes.get(c.adoptedTakeId)?.durationMs ?? null) : null,
          }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM lot_comic_drama.cd_clips c") && sql.includes("WHERE c.series_id=$2")) {
        const sId = String(params[1]);
        const rows = [...clips.values()]
          .filter(c => c.seriesId === sId && c.adoptedTakeId)
          .map(c => ({
            seriesId: c.seriesId, clipId: c.id, ordinal: c.ordinal, scene: c.scene,
            adoptedTakeId: c.adoptedTakeId,
            adoptedDurationMs: c.adoptedTakeId ? (takes.get(c.adoptedTakeId)?.durationMs ?? null) : null,
          }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('SELECT id AS "takeId", target_id AS "clipId" FROM lot_comic_drama.cd_takes')) {
        const ids = new Set(params[1] as string[]);
        const rows = [...takes.values()].filter(t => ids.has(t.takeId)).map(t => ({ takeId: t.takeId, clipId: t.clipId }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM lot_comic_drama.cd_edits") && sql.includes("drama_edit_task_id=$2 AND series_id=$3")) {
        const taskId = String(params[1]);
        const sId = String(params[2]);
        const hit = [...edits.values()].find(e => e.dramaEditTaskId === taskId && e.seriesId === sId);
        return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes("ARRAY(SELECT adopted_video_take_id")) {
        const sId = String(params[1]);
        const adopted = [...clips.values()].filter(c => c.seriesId === sId && c.adoptedTakeId).map(c => c.adoptedTakeId!);
        return { rows: [{ aspect: "9:16", adopted }], rowCount: 1 };
      }
      if (sql.includes('SELECT t.id AS "takeId",t.media_id AS "mediaId"')) {
        const ids = new Set(params[1] as string[]);
        const rows = [...takes.values()]
          .filter(t => ids.has(t.takeId))
          .map(t => ({
            takeId: t.takeId, mediaId: t.mediaId, dramaId, dramaTitle: "雨夜便利店",
            episodeNo: 1, seriesTitle: "第一集", seriesId: t.seriesId, clipId: t.clipId,
            clipOrdinal: clips.get(t.clipId)?.ordinal ?? 1, scene: clips.get(t.clipId)?.scene ?? "",
            version: 1, durationMs: t.durationMs, aspectRatio: "9:16", audioMode: "silent_tts", adopted: null,
          }));
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("INSERT INTO lot_comic_drama.cd_edits(owner_id,series_id,drama_edit_task_id")) {
        const id = uuid(100 + seq++);
        const created: StoredEdit = {
          id, ownerId, seriesId: String(params[1]), dramaEditTaskId: String(params[2]),
          title: String(params[3]), revision: 1, timeline: params[4] as ComicTimeline, updatedAt: new Date(),
        };
        edits.set(id, created);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.includes("FROM lot_comic_drama.cd_edits e") && sql.includes("WHERE e.owner_id=$1 AND e.id=$2")) {
        const hit = edits.get(String(params[1]));
        if (!hit) return { rows: [], rowCount: 0 };
        const ep = episodes.find(item => item.id === hit.seriesId);
        return {
          rows: [{
            id: hit.id, seriesId: hit.seriesId, dramaEditTaskId: hit.dramaEditTaskId,
            dramaId: hit.dramaEditTaskId ? dramaId : null,
            dramaTitle: hit.dramaEditTaskId ? "雨夜便利店" : null,
            episodeNo: ep?.episodeNo ?? null, episodeTitle: ep?.title ?? null,
            title: hit.title, revision: hit.revision, updatedAt: hit.updatedAt,
            dramaArchivedAt: null, timeline: hit.timeline,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_edits SET title=$3,timeline=$4")) {
        const hit = edits.get(String(params[1]));
        if (hit) {
          hit.title = String(params[2]);
          hit.timeline = params[3] as ComicTimeline;
          hit.revision += 1;
          hit.updatedAt = new Date();
        }
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO lot_comic_drama.cd_user_state")) {
        lastEditId = String(params[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("WHERE e.owner_id=$1 AND e.drama_edit_task_id IS NULL")) {
        const freeRows = [...edits.values()].filter(e => !e.dramaEditTaskId).map(e => ({
          id: e.id, seriesId: e.seriesId, dramaEditTaskId: null, dramaId: null, dramaTitle: null,
          episodeNo: null, episodeTitle: null, title: e.title, revision: e.revision,
          updatedAt: e.updatedAt, dramaArchivedAt: null, stamp: e.updatedAt.toISOString(),
        }));
        return { rows: freeRows, rowCount: freeRows.length };
      }
      if (sql.includes("FROM lot_comic_drama.cd_user_state u")) {
        const hit = lastEditId ? edits.get(lastEditId) : undefined;
        if (!hit) return { rows: [], rowCount: 0 };
        const ep = episodes.find(item => item.id === hit.seriesId);
        return {
          rows: [{
            id: hit.id, title: hit.title, taskKind: hit.dramaEditTaskId ? "drama" : "free",
            dramaId: hit.dramaEditTaskId ? dramaId : null,
            dramaTitle: hit.dramaEditTaskId ? "雨夜便利店" : null,
            seriesId: hit.seriesId, episodeNo: ep?.episodeNo ?? null, episodeTitle: ep?.title ?? null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM lot_comic_drama.cd_edit_tasks t") && sql.includes("JOIN lot_comic_drama.cd_dramas d")) {
        const t = editTasks.get(dramaId);
        if (!t) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            id: t.id, dramaId, dramaTitle: "雨夜便利店", synopsis: "", styleKey: "thick_painting",
            aspectRatio: "9:16", archivedAt: null, lastSeriesId: t.lastSeriesId, updatedAt: t.updatedAt, coverMediaId: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("DELETE FROM lot_comic_drama.cd_edits WHERE owner_id=$1 AND id=$2")) {
        edits.delete(String(params[1]));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const client: PoolClient = { query, release: vi.fn() } as unknown as PoolClient;
    const pool: Pool = { connect: vi.fn(async () => client), query } as unknown as Pool;
    const repo = new PgComicEdits(pool);

    // 1. Open drama editing task on Episode 1 -> seeds timeline with Clip 1's adopted take
    const openedEp1 = await repo.openDramaTask(ownerId, dramaId, ep1Id);
    expect(openedEp1.activeSeriesId).toBe(ep1Id);
    expect(openedEp1.edit?.taskKind).toBe("drama");
    expect(openedEp1.edit?.timeline.video.map(v => v.takeId)).toEqual([take1Id]);
    expect(openedEp1.episodes).toHaveLength(2);
    expect(openedEp1.episodes[0]?.timelineClipCount).toBe(1);

    // 2. Adopt Clip 2 later -> unaddedAdoptedTakes shows Clip 2, syncEpisodeSources appends it cleanly
    clips.get(clip2Id)!.adoptedTakeId = take2Id;
    const reloaded = await repo.get(ownerId, openedEp1.edit!.id);
    expect(reloaded.unaddedAdoptedTakes?.map(u => u.takeId)).toEqual([take2Id]);
    const synced = await repo.syncEpisodeSources(ownerId, reloaded.id, reloaded.revision);
    expect(synced.timeline.video.map(v => v.takeId)).toEqual([take1Id, take2Id]);
    expect(synced.unaddedAdoptedTakes).toEqual([]);

    // 3. Switch to Episode 2 -> creates independent episode unit and updates lastSeriesId
    const openedEp2 = await repo.openDramaTask(ownerId, dramaId, ep2Id);
    expect(openedEp2.activeSeriesId).toBe(ep2Id);
    expect(openedEp2.edit?.id).not.toBe(openedEp1.edit?.id);
    expect(openedEp2.edit?.timeline.video).toEqual([]);
    expect(openedEp2.task.lastSeriesId).toBe(ep2Id);

    // 4. Deleting a drama-bound episode edit is blocked, while listing separates dramaTasks and free entries
    await expect(repo.remove(ownerId, openedEp1.edit!.id, synced.revision)).rejects.toMatchObject({
      code: "EDIT_DRAMA_BOUND",
    });
    const listed = await repo.list(ownerId);
    expect(listed.dramaTasks).toHaveLength(1);
    expect(listed.dramaTasks?.[0]?.editedEpisodeCount).toBe(1);
    expect(listed.entries.map(e => e.id)).toEqual([freeEditId]);
    expect(listed.lastEdit?.taskKind).toBe("drama");
    expect(listed.lastEdit?.seriesId).toBe(ep2Id);

    // 5. Deleting a free task succeeds
    await repo.remove(ownerId, freeEditId, 1);
    const listedAfterDelete = await repo.list(ownerId);
    expect(listedAfterDelete.entries).toEqual([]);
  });
});
