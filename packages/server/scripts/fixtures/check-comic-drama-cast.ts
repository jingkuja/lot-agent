import assert from "node:assert/strict";
import type { Hono } from "hono";
import { COMIC_DRAMA_API_ROOT, type ComicDramaContent, type ComicDramaDetail, type ComicDramaListing } from "@lot-agent/core/comic-drama";
import { comicFixturePng } from "./check-comic-drama-library.js";

export async function verifyComicCast(app: Hono<{ Variables: { userId: string } }>) {
  async function api<T>(path: string, method = "GET", data?: unknown, status = 200, account = "fixture-one", mime = "application/json") {
    const response = await app.request(COMIC_DRAMA_API_ROOT + path, {
      method, headers: { Authorization: `Bearer ${account}`, "Content-Type": mime },
      body: data === undefined ? undefined : Buffer.isBuffer(data) ? new Uint8Array(data) : JSON.stringify(data),
    });
    const json = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(json)}`);
    return json as T;
  }

  const character = { name: "W4 林夏", aliases: [], tags: [], roleKey: null, age: "", personality: "", appearance: "短发" };
  const { id: characterId } = await api<{ id: string }>("/characters", "POST", character, 201);
  const characterPath = "/characters/" + characterId;
  const outfit = await api<{ id: string }>(characterPath + "/outfits", "POST", { name: "雨衣" }, 201);
  const unrelated = await api<{ id: string }>(characterPath + "/outfits", "POST", { name: "风衣" }, 201);
  const first = await comicFixturePng();
  const second = await comicFixturePng("#743a36");
  const upload = (outfitId: string, data: Buffer) => api<{ mediaId: string; version: number }>(
    characterPath + "/files?kind=slot&key=front&outfitId=" + outfitId, "POST", data, 201, "fixture-one", "image/png",
  );
  const oldImage = await upload(outfit.id, first);
  const input = { title: "W4 雨夜", styleKey: "ink", aspectRatio: "9:16", videoModel: null };
  const { series } = await api<ComicDramaDetail>("/series", "POST", input, 201);
  const episodePath = "/series/" + series.id;
  const castPath = episodePath + "/cast";
  await api(castPath, "POST", { expectedRevision: 1, characterId, outfitId: outfit.id }, 404, "fixture-two");
  const foreign = await api<ComicDramaDetail>("/series", "POST", input, 201, "fixture-two");
  await api(`/series/${foreign.series.id}/cast`, "POST", { expectedRevision: 1, characterId, outfitId: outfit.id }, 404, "fixture-two");
  const locked = await api<ComicDramaContent>(castPath, "POST", { expectedRevision: 1, characterId, outfitId: outfit.id }, 201);
  const initialSnapshot = locked.cast[0].snapshot;
  assert.equal(initialSnapshot.assets[0].media.id, oldImage.mediaId);
  await api(castPath, "POST", { expectedRevision: 1, characterId, outfitId: outfit.id }, 409);
  const body = await api<ComicDramaContent>(episodePath + "/clips", "POST", { expectedRevision: locked.seriesRevision }, 201);
  const clip = body.clips[0];
  const clipPath = episodePath + "/clips/" + clip.id;
  const draft = { ...clip.draft, cast: [{ characterId, slotKey: "front", expressionKey: null }] };
  await api(clipPath, "PATCH", { expectedRevision: clip.revision, draft: { ...draft, cast: [{ ...draft.cast[0], slotKey: "back" }] } }, 400);
  await api(clipPath, "PATCH", { expectedRevision: clip.revision, draft });
  await upload(unrelated.id, first);
  const unchanged = await api<ComicDramaDetail>(episodePath);
  assert.equal(unchanged.cast[0].hasUpdates, false);
  const newImage = await upload(outfit.id, second);
  const stale = await api<ComicDramaDetail>(episodePath);
  assert.equal(stale.cast[0].hasUpdates, true);
  assert.deepEqual(stale.cast[0].snapshot, initialSnapshot);
  const sequel = await api<ComicDramaDetail>(episodePath + "/sequel", "POST", { inheritCastAndStyle: true }, 201);
  assert.deepEqual(sequel.cast[0].snapshot, initialSnapshot);
  assert.equal(sequel.series.styleKey, "ink");
  const cleanSequel = await api<ComicDramaDetail>(episodePath + "/sequel", "POST", { inheritCastAndStyle: false }, 201);
  assert.deepEqual(cleanSequel.cast, []);
  assert.equal(cleanSequel.series.styleKey, "thick_painting");
  const copy = await api<ComicDramaDetail>(episodePath + "/copy", "POST", {}, 201);
  assert.deepEqual(copy.cast[0].snapshot, initialSnapshot);
  assert.deepEqual(copy.clips[0].draft.cast, draft.cast);

  const updated = await api<ComicDramaContent>(castPath + "/" + characterId + "/sync", "POST", { expectedRevision: stale.series.revision });
  assert.equal(updated.cast[0].snapshot.assets[0].media.id, newImage.mediaId);
  assert.equal(updated.cast[0].hasUpdates, false);
  const isolated = await api<ComicDramaDetail>("/series/" + sequel.series.id);
  assert.equal(isolated.cast[0].snapshot.assets[0].media.id, oldImage.mediaId);
  assert.equal(isolated.cast[0].hasUpdates, true);

  const emptyOutfit = await api<{ id: string }>(characterPath + "/outfits", "POST", { name: "空套装" }, 201);
  const change = await api<ComicDramaContent>(castPath + "/" + characterId, "PATCH", {
    expectedRevision: updated.seriesRevision, outfitId: emptyOutfit.id,
  });
  assert.equal(change.clips[0].draft.cast?.[0].slotKey, null);
  await api(clipPath, "PATCH", { expectedRevision: updated.clips[0].revision, draft }, 409);
  const removed = await api<ComicDramaContent>(castPath + "/" + characterId, "DELETE", { expectedRevision: change.seriesRevision });
  assert.deepEqual(removed.cast, []);
  assert.deepEqual(removed.clips[0].draft.cast, []);
  await api(characterPath + "/archive", "POST");
  const archivedCast = (await api<ComicDramaDetail>("/series/" + sequel.series.id)).cast[0];
  assert.equal(archivedCast.archived, true);
  assert.equal(archivedCast.snapshot.assets[0].media.id, oldImage.mediaId);

  for (let i = 0; i < 25; i++) {
    await api("/series", "POST", { ...input, title: "W4 分页 " + i }, 201);
  }
  const firstPage = await api<ComicDramaListing>("/series?query=" + encodeURIComponent("W4 分页"));
  assert.equal(firstPage.entries.length, 24);
  assert.ok(firstPage.nextCursor);
  const secondPage = await api<ComicDramaListing>("/series?" + new URLSearchParams({ query: "W4 分页", cursor: firstPage.nextCursor }));
  assert.equal(secondPage.entries.length, 1);
  assert.ok(!firstPage.entries.some(row => row.id === secondPage.entries[0].id));
  assert.equal(secondPage.nextCursor, null);
  console.log("PASS W4 PG/HTTP: isolated cast snapshots, reference validation, update detection, sequel and copy, sync, archive and history pagination");
}
