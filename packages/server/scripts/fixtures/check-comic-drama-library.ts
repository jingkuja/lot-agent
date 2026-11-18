import assert from "node:assert/strict";
import type { Hono } from "hono";
import sharp from "sharp";
import { COMIC_DRAMA_API_ROOT, type ComicDictionaryEntry, type ComicMediaLinks, type ComicMediaVersion } from "@lot-agent/core/comic-drama";

export const comicFixturePng = (background = "#41648b") =>
  sharp({ create: { width: 660, height: 330, channels: 3, background } }).png().toBuffer();

function wave(seconds: number) {
  const length = seconds * 8000 * 2;
  const buffer = Buffer.alloc(44 + length);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + length, 4);
  buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(length, 40);
  return buffer;
}

type App = Hono<{ Variables: { userId: string } }>;
export async function verifyComicLibrary(app: App, advanceClock: (ms: number) => void) {
  const library = (path: string, method = "GET", data?: unknown, user = "fixture-one", mime = "application/json") =>
    app.request(COMIC_DRAMA_API_ROOT + path, {
      method, headers: { Authorization: `Bearer ${user}`, "Content-Type": mime },
      body: data === undefined ? undefined : Buffer.isBuffer(data) ? new Uint8Array(data) : JSON.stringify(data),
    });
  const result = async <T>(response: Promise<Response>, status: number) => {
    const res = await response;
    const json = await res.json();
    assert.equal(res.status, status, JSON.stringify(json));
    return json as T;
  };
  const labels = { zh: "黄昏同名", en: "Dusk", id: "Senja" };
  const key = "dusk";
  const first = await result<ComicDictionaryEntry[]>(library("/dictionary/scene", "POST", { key, labels }), 201);
  const second = await result<ComicDictionaryEntry[]>(
    library("/dictionary/scene", "POST", { key, labels: { ...labels, zh: "另一个黄昏" } }, "fixture-two"), 201,
  );
  assert.equal(first.find(entry => entry.key === key)?.labels.zh, "黄昏同名");
  assert.equal(second.find(entry => entry.key === key)?.labels.zh, "另一个黄昏");
  await result(library("/dictionary/scene/interior", "PATCH", { labels }), 400);
  const sorted = await result<ComicDictionaryEntry[]>(
    library("/dictionary/scene/order", "PUT", { keys: [key, ...first.filter(entry => entry.key !== key).map(entry => entry.key)] }), 200,
  );
  assert.equal(sorted[0].key, key);
  await result(library("/dictionary/scene/interior", "PATCH", { inactive: true }), 200);
  const unaffected = await result<ComicDictionaryEntry[]>(library("/dictionary/scene", "GET", undefined, "fixture-two"), 200);
  assert.equal(unaffected.find(entry => entry.key === "interior")?.inactive, false);

  const image = await comicFixturePng();
  const image2 = await comicFixturePng("#8a4747");
  const mediaPath = "/materials/upload?kind=scene&name=" + encodeURIComponent("夜景") + "&categoryKey=" + key;
  const one = await result<{ id: string; mediaId: string }>(library(mediaPath, "POST", image, "fixture-one", "image/png"), 201);
  const two = await result<{ id: string; mediaId: string }>(library(mediaPath, "POST", image2, "fixture-two", "image/png"), 201);
  assert.notEqual(one.id, two.id);
  const list = await result<{ entries: Array<{ id: string }> }>(library("/materials?kind=scene"), 200);
  assert.deepEqual(list.entries.map(row => row.id), [one.id]);
  await result(library(`/materials/${one.id}/files`, "POST", image2, "fixture-two", "image/png"), 404);
  await result(library(`/media/${one.mediaId}/links`, "GET", undefined, "fixture-two"), 404);
  const links = await result<ComicMediaLinks>(library(`/media/${one.mediaId}/links`), 200);
  const bare = links.url.split("?")[0];
  assert.equal((await app.request(bare)).status, 404);
  assert.equal((await app.request(bare, { headers: { Authorization: "Bearer fixture-two" } })).status, 404);
  const preview = await app.request(links.thumbnailUrl!);
  assert.equal(preview.status, 200);
  const thumb = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
  assert.deepEqual([thumb.width, thumb.height, thumb.format], [480, 240, "webp"]);
  const portion = await app.request(links.url, { headers: { Range: "bytes=1-8" } });
  assert.equal(portion.status, 206);
  assert.equal(portion.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await portion.arrayBuffer()).byteLength, 8);

  const replacement = await result<{ version: number; mediaId: string }>(
    library(`/materials/${one.id}/files`, "POST", image2, "fixture-one", "image/png"), 201,
  );
  assert.equal(replacement.version, 2);
  await result(library(`/materials/${one.id}/archive`, "POST"), 200);
  const history = await result<ComicMediaVersion[]>(library(`/materials/${one.id}/versions`), 200);
  assert.deepEqual(history.map(entry => entry.media.id), [replacement.mediaId, one.mediaId]);
  advanceClock(11 * 60 * 1000);
  assert.equal((await app.request(links.url)).status, 404);
  const renewed = await result<ComicMediaLinks>(library(`/media/${one.mediaId}/links`), 200);
  assert.deepEqual(Buffer.from(await (await app.request(renewed.url)).arrayBuffer()), image);

  const charData = { name: "林夏", aliases: ["小夏"], tags: [], roleKey: "lead", age: "24", personality: "勇敢", appearance: "短发" };
  const char = await result<{ id: string }>(library("/characters", "POST", charData), 201);
  const outfit = await result<{ id: string }>(library(`/characters/${char.id}/outfits`, "POST", { name: "雨衣" }), 201);
  const path = `/characters/${char.id}`;
  const slot = "?kind=slot&key=front&outfitId=" + outfit.id;
  assert.equal((await library(path, "GET", undefined, "fixture-two")).status, 404);
  const assets = await Promise.all([image, image2].map(data => result<{ version: number }>(library(
    path + "/files" + slot, "POST", data, "fixture-one", "image/png",
  ), 201)));
  assert.deepEqual(assets.map(asset => asset.version).sort(), [1, 2]);
  await result(library(path + "/files?kind=expression&key=smile", "POST", image, "fixture-one", "image/png"), 201);
  const frontHistory = await result<ComicMediaVersion[]>(library(path + "/versions" + slot), 200);
  assert.deepEqual(frontHistory.map(entry => entry.version), [2, 1]);
  assert.equal((await library(path + "/versions" + slot, "GET", undefined, "fixture-two")).status, 404);

  await result(library(mediaPath, "POST", Buffer.from("not its declared format"), "fixture-one", "image/png"), 415);
  await result(library(mediaPath, "POST", Buffer.alloc(20 * 1024 * 1024 + 1), "fixture-one", "image/png"), 413);
  await result(library("/materials/upload?kind=sound&name=rain", "POST", wave(31), "fixture-one", "audio/wav"), 400);
  const sound = await result<{ id: string }>(library("/materials/upload?kind=sound&name=rain", "POST", wave(1), "fixture-one", "audio/wav"), 201);
  const sounds = await result<ComicMediaVersion[]>(library(`/materials/${sound.id}/versions`), 200);
  assert.equal(sounds[0].media.durationMs, 1000);
  console.log("PASS W3 PG/HTTP: dictionary isolation, media limits and probe, thumbnails, two-owner same-name uploads, history, Range and renewed links");
}
