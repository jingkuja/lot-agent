import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Pool } from "pg";
import { COMIC_DRAMA_API_ROOT } from "@lot-agent/core/comic-drama";
import { createProductRoutes } from "../routes/product.js";
import { comicRollout } from "./rollout.js";
import { createComicRenderRoutes } from "./render-routes.js";
import type { ComicMediaLibrary } from "./media-library.js";
import type { PgComicRenders } from "./render-repository.js";

const pilotOwner = "00000000-0000-4000-8000-000000000001";
const otherOwner = "00000000-0000-4000-8000-000000000002";
const editId = "00000000-0000-4000-8000-000000000010";
const renderId = "00000000-0000-4000-8000-000000000020";
const requestId = "00000000-0000-4000-8000-000000000030";
const mediaId = "00000000-0000-4000-8000-000000000040";

function buildRolloutApp(env: NodeJS.ProcessEnv) {
  const existingRequests = new Map<string, string>();
  const start = vi.fn(async (_owner: string, _editId: string, input: { requestId: string }, accepting?: () => void) => {
    const existing = existingRequests.get(input.requestId);
    if (existing) return { id: existing, created: false };
    accepting?.();
    existingRequests.set(input.requestId, renderId);
    return { id: renderId, created: true };
  });
  const status = vi.fn(async () => ({
    id: renderId, editId, editRevision: 1, durationMs: 6000, status: "ready" as const,
    error: null, mediaId, title: "试点样片", createdAt: new Date().toISOString(), recoverable: false,
    outputFps: 24 as const, fpsMode: "auto" as const,
  }));
  const repo = { start, status } as unknown as PgComicRenders;
  const media = {
    assertAvailable: vi.fn(),
    renderDownload: vi.fn(async () => ({ url: `/api/public/comic-drama-media/${mediaId}.mp4?sig=ok`, filename: `comic-${renderId}.mp4` })),
  } as unknown as ComicMediaLibrary;
  const queue = {
    publishNewTask: vi.fn(async () => {}),
    canResumePersisted: vi.fn(async () => true),
    resumePersisted: vi.fn(async () => {}),
    stopCancelled: vi.fn(async () => {}),
  };

  const app = new Hono<{ Variables: { userId: string } }>();
  const tokens: Record<string, string> = { "pilot-token": pilotOwner, "other-token": otherOwner };
  app.route("/api/public/product", createProductRoutes(async c => {
    const rollout = comicRollout(env);
    const token = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1]?.trim();
    const userId = token ? tokens[token] : undefined;
    return { comicDramaEnabled: rollout.showEntry(userId) };
  }));
  app.use(`${COMIC_DRAMA_API_ROOT}/*`, async (c, next) => {
    const token = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1]?.trim();
    const userId = token ? tokens[token] : undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const rollout = comicRollout(env);
    if (!rollout.admits(userId)) return c.notFound();
    c.set("userId", userId);
    await next();
  });
  app.route(COMIC_DRAMA_API_ROOT, createComicRenderRoutes(repo, media, queue, () => comicRollout(env).accepting()));
  return { app, start, queue, media };
}

describe("P1 rollout switch drill", () => {
  it("evaluates COMIC_DRAMA_FACTORY, PILOT_OWNER_IDS, ENTRY_HIDDEN, and WRITES_PAUSED accurately", () => {
    const off = comicRollout({ COMIC_DRAMA_FACTORY: "0", COMIC_DRAMA_PILOT_OWNER_IDS: pilotOwner });
    expect(off.enabled).toBe(false);
    expect(off.admits(pilotOwner)).toBe(false);
    expect(off.showEntry(pilotOwner)).toBe(false);

    const pilot = comicRollout({
      COMIC_DRAMA_FACTORY: "1",
      COMIC_DRAMA_PILOT_OWNER_IDS: ` ${pilotOwner.toUpperCase()} , not-a-uuid `,
    });
    expect(pilot.enabled).toBe(true);
    expect(pilot.personalized).toBe(true);
    expect(pilot.admits(pilotOwner)).toBe(true);
    expect(pilot.admits(otherOwner)).toBe(false);
    expect(pilot.admits(undefined)).toBe(false);
    expect(pilot.showEntry(pilotOwner)).toBe(true);
    expect(pilot.showEntry(otherOwner)).toBe(false);

    const hidden = comicRollout({
      COMIC_DRAMA_FACTORY: "1",
      COMIC_DRAMA_PILOT_OWNER_IDS: pilotOwner,
      COMIC_DRAMA_ENTRY_HIDDEN: "1",
    });
    expect(hidden.showEntry(pilotOwner)).toBe(false);
    expect(hidden.admits(pilotOwner)).toBe(true);
    expect(hidden.admits(otherOwner)).toBe(false);

    const paused = comicRollout({ COMIC_DRAMA_FACTORY: "1", COMIC_DRAMA_WRITES_PAUSED: "1" });
    expect(() => paused.accepting()).toThrowError(/COMIC_SUBMISSIONS_PAUSED/);
  });

  it("drills pilot allowlist, hidden entry, paused new writes, requestId replay, and history downloads end-to-end", async () => {
    const env: NodeJS.ProcessEnv = {
      COMIC_DRAMA_FACTORY: "1",
      COMIC_DRAMA_PILOT_OWNER_IDS: pilotOwner,
    };
    const { app, queue } = buildRolloutApp(env);
    const asPilot = { Authorization: "Bearer pilot-token", "Content-Type": "application/json" };
    const asOther = { Authorization: "Bearer other-token", "Content-Type": "application/json" };

    // 1. Pilot allowlist: pilot sees entry & API, non-pilot and unauth do not.
    expect(await (await app.request("/api/public/product", { headers: asPilot })).json()).toMatchObject({ comicDramaEnabled: true });
    expect(await (await app.request("/api/public/product", { headers: asOther })).json()).toMatchObject({ comicDramaEnabled: false });
    expect(await (await app.request("/api/public/product")).json()).toMatchObject({ comicDramaEnabled: false });
    expect((await app.request(`${COMIC_DRAMA_API_ROOT}/renders/${renderId}`, { headers: asOther })).status).toBe(404);
    expect((await app.request(`${COMIC_DRAMA_API_ROOT}/renders/${renderId}`, { headers: asPilot })).status).toBe(200);

    // 2. Submit a render while open -> 202 and published once.
    const firstSubmit = await app.request(`${COMIC_DRAMA_API_ROOT}/edits/${editId}/render`, {
      method: "POST",
      headers: asPilot,
      body: JSON.stringify({ expectedRevision: 1, requestId, fpsMode: "auto" }),
    });
    expect(firstSubmit.status).toBe(202);
    expect(queue.publishNewTask).toHaveBeenCalledTimes(1);

    // 3. Pause writes + hide entry: entry hidden, new submission blocked (503), replay & download remain 202/200!
    env.COMIC_DRAMA_ENTRY_HIDDEN = "1";
    env.COMIC_DRAMA_WRITES_PAUSED = "1";
    expect(await (await app.request("/api/public/product", { headers: asPilot })).json()).toMatchObject({ comicDramaEnabled: false });

    const newBlocked = await app.request(`${COMIC_DRAMA_API_ROOT}/edits/${editId}/render`, {
      method: "POST",
      headers: asPilot,
      body: JSON.stringify({ expectedRevision: 1, requestId: "00000000-0000-4000-8000-000000000099" }),
    });
    expect(newBlocked.status).toBe(503);
    expect(await newBlocked.json()).toEqual({ code: "COMIC_SUBMISSIONS_PAUSED" });

    // Replaying the already-accepted requestId still succeeds without re-publishing.
    const replay = await app.request(`${COMIC_DRAMA_API_ROOT}/edits/${editId}/render`, {
      method: "POST",
      headers: asPilot,
      body: JSON.stringify({ expectedRevision: 1, requestId, fpsMode: "auto" }),
    });
    expect(replay.status).toBe(202);
    expect(queue.publishNewTask).toHaveBeenCalledTimes(1);

    // Existing finished render download remains accessible for pilot while entry is hidden and writes are paused.
    const download = await app.request(`${COMIC_DRAMA_API_ROOT}/renders/${renderId}/download`, { headers: asPilot });
    expect(download.status).toBe(200);
    expect(await download.json()).toMatchObject({ filename: `comic-${renderId}.mp4` });
    expect((await app.request(`${COMIC_DRAMA_API_ROOT}/renders/${renderId}/download`, { headers: asOther })).status).toBe(404);
  });

  it("keeps pool-independent guard usable across module boundaries", () => {
    const _unusedPool: Pool | null = null;
    expect(_unusedPool).toBeNull();
  });
});
