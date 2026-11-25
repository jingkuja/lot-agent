import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { Hono } from "hono";
import type { Pool } from "pg";
import {
  COMIC_DRAMA_API_ROOT, comicVideoItem, type ComicEdit, type ComicRender, type ComicRenderDownload, type ComicRenderHistory, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import type { ComicMediaLibrary } from "../../src/comic-drama/media-library.js";
import { PgComicRenders } from "../../src/comic-drama/render-repository.js";
import { createComicRenderRoutes } from "../../src/comic-drama/render-routes.js";
import { runComicRender } from "../../src/comic-drama/render-worker.js";
import type { BullmqJobQueue } from "../../src/jobs/bullmq-queue.js";
import { COMIC_RENDER_TASK } from "../../src/jobs/task-queues.js";
import { ffmpeg, ffprobe, inspectMedia, mediaProcess } from "../../src/marketing-video/media.js";
import type { verifyComicEdits } from "./check-comic-drama-edits.js";

type App = Hono<{ Variables: { userId: string } }>;
export function mountComicRenderFixture(app: App, pool: Pool, media: ComicMediaLibrary, queue: BullmqJobQueue, accepting?: () => void) {
  let hold: Promise<void> | undefined;
  let skipNext = false;
  queue.process(COMIC_RENDER_TASK, async (job, ctl) => {
    await hold;
    return runComicRender(pool, media, job, ctl.signal);
  });
  app.route(COMIC_DRAMA_API_ROOT, createComicRenderRoutes(new PgComicRenders(pool), media, {
    async publishNewTask(id, type) {
      if (skipNext) { skipNext = false; throw new Error("fixture dispatch unavailable"); }
      return queue.publishNewTask(id, type);
    },
    stopCancelled: id => queue.stopCancelled(id), canResumePersisted: id => queue.canResumePersisted(id),
    resumePersisted: (id, type) => queue.resumePersisted(id, type),
  }, accepting));
  const pause = () => {
    let release: () => void = () => {};
    hold = new Promise<void>(resolve => { release = resolve; });
    return () => { hold = undefined; release(); };
  };
  return { pause, queue, skip: () => { skipNext = true; } };
}

export async function verifyComicRenders(app: App, pool: Pool, media: ComicMediaLibrary, root: string, owner: string,
  seed: Awaited<ReturnType<typeof verifyComicEdits>>, fixture: ReturnType<typeof mountComicRenderFixture>) {
  const request = (path: string, method = "GET", data?: unknown, token = "fixture-one") => app.request(COMIC_DRAMA_API_ROOT + path, {
    method, body: data === undefined ? undefined : JSON.stringify(data),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  async function json<T>(path: string, method = "GET", data?: unknown, expected = 200, token = "fixture-one"): Promise<T> {
    const response = await request(path, method, data, token);
    const body = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(body)}`);
    return body as T;
  }
  async function sound(kind: "music" | "sound", name: string, frequency: number, seconds: number) {
    const file = join(root, kind + ".wav");
    await mediaProcess(ffmpeg(), ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}`, "-c:a", "pcm_s16le", file]);
    const query = new URLSearchParams({ kind, name });
    const response = await app.request(COMIC_DRAMA_API_ROOT + "/materials/upload?" + query, { method: "POST",
      headers: { Authorization: "Bearer fixture-one", "Content-Type": "audio/wav" }, body: new Uint8Array(await readFile(file)) });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json() as { mediaId: string }).mediaId;
  }
  const music = await sound("music", "W9 配乐样例", 660, 1);
  const sfx = await sound("sound", "W9 音效样例", 990, 0.5);
  const fresh = await json<ComicEdit>("/edits", "POST", { title: "W9 导出验收", takeId: seed.a1.takeId }, 201);
  const path = "/edits/" + fresh.id;
  const first = fresh.timeline.video[0];
  const second = { ...comicVideoItem(randomUUID(), seed.b1), inMs: 400, outMs: 7600 };
  const anchored = (videoItemId: string, offsetMs: number) => ({ kind: "clip" as const, videoItemId, offsetMs });
  const at = (offsetMs: number) => ({ kind: "timeline" as const, offsetMs });
  const audio = (mediaId: string, anchor: ComicTimeline["voice"][number]["anchor"], durationMs: number) =>
    ({ id: randomUUID(), mediaId, anchor, durationMs, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false });
  const caption = (text: string, offset: number) => ({ id: randomUUID(), anchor: at(offset), durationMs: 800, text });
  const timeline: ComicTimeline = { ...fresh.timeline, video: [first, second],
    voice: [audio(seed.speechMediaId, anchored(first.id, 1000), 1000)],
    music: [{ ...audio(music, at(0), 12_700), volume: 0.3, loop: true, fadeInMs: 400, fadeOutMs: 300 }],
    sfx: [audio(sfx, anchored(second.id, 500), 500)],
    subtitles: [caption("雨夜便利店", 200), caption("The shop is open", 2200), caption("Toko masih buka", 4200),
      { ...caption("预告", 0), anchor: anchored(second.id, 5000) }],
  };
  const save = (expectedRevision: number, draft: ComicTimeline) =>
    json<ComicEdit>(path, "PATCH", { expectedRevision, title: fresh.title, timeline: draft });
  const exportClip = (revision: number, requestId = randomUUID()) =>
    json<ComicRender>(path + "/render", "POST", { expectedRevision: revision, requestId }, 202);
  const status = (id: string) => json<ComicRender>("/renders/" + id);
  const overflow = await save(fresh.revision, { ...timeline, voice: [{ ...timeline.voice[0], anchor: anchored(first.id, 5700) }] });
  assert.equal((await json<{ code: string }>(path + "/render", "POST",
    { expectedRevision: overflow.revision, requestId: randomUUID() }, 400)).code, "RENDER_TRACK_OVERFLOW");
  const clean = await save(overflow.revision, timeline);
  assert.equal((await json<{ code: string }>(path + "/items/" + second.id + "/replace", "POST",
    { expectedRevision: clean.revision, takeId: seed.b2.takeId, outMs: 5000 }, 409)).code, "EDIT_ATTACHED_OVERFLOW");
  await json(path + "/render", "POST", { expectedRevision: clean.revision - 1, requestId: randomUUID() }, 409);
  await json(path + "/render", "POST", { expectedRevision: clean.revision, requestId: randomUUID() }, 404, "fixture-two");
  let original: ComicRender, changed: ComicEdit;
  const release = fixture.pause();
  const nonce = randomUUID();
  try {
    const [one, same] = await Promise.all([exportClip(clean.revision, nonce), exportClip(clean.revision, nonce.toUpperCase())]);
    assert.equal(one.id, same.id);
    original = one;
    assert.equal(one.durationMs, 13_200);
    const changedTimeline: ComicTimeline = { ...timeline,
      video: [first, { ...second, transitionIn: { kind: "crossfade", durationMs: 500 } }],
      subtitles: timeline.subtitles.map((cue, index) => index === 0 ? { ...cue, text: "修订版字幕" } : cue),
    };
    changed = await save(clean.revision, changedTimeline);
    assert.equal((await exportClip(clean.revision, nonce)).id, one.id);
    await json(path + "/render", "POST", { expectedRevision: changed.revision, requestId: nonce }, 409);
    const { rows: [frozen] } = await pool.query("SELECT frozen FROM lot_comic_drama.cd_renders WHERE id=$1", [one.id]);
    assert.equal(frozen.frozen.timeline.subtitles[0].text, "雨夜便利店");
  } finally { release(); }

  async function ready(render: ComicRender) {
    for (let i = 0; i < 600; i++) {
      const current = await status(render.id);
      if (current.status === "failed") throw new Error("W9 render failed: " + current.error);
      if (current.status === "ready" && current.mediaId) {
        const file = await media.renderSource(owner, current.mediaId, "video");
        return { ...current, file: file.path, mediaId: current.mediaId };
      }
      await delay(150);
    }
    throw new Error("W9 render did not finish: " + render.id);
  }
  const noFade = await ready(original);
  const fade = await ready(await exportClip(changed.revision));
  const repeat = await ready(await exportClip(changed.revision));
  const black = await save(changed.revision, { ...changed.timeline,
    video: [first, { ...second, transitionIn: { kind: "black", durationMs: 500 } }],
  });
  const blackFade = await ready(await exportClip(black.revision));
  const cancelHold = fixture.pause();
  let cancelled: ComicRender;
  try {
    const cancelTarget = await exportClip(black.revision);
    for (let i = 0; i < 100 && (await status(cancelTarget.id)).status !== "running"; i++) await delay(25);
    assert.equal((await status(cancelTarget.id)).status, "running");
    await json("/renders/" + cancelTarget.id, "DELETE", undefined, 409);
    await json("/renders/" + cancelTarget.id + "/cancel", "POST", {}, 404, "fixture-two");
    cancelled = await json<ComicRender>("/renders/" + cancelTarget.id + "/cancel", "POST", {});
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.mediaId, null);
    await json("/renders/" + cancelTarget.id + "/recover", "POST", {}, 409);
  } finally { cancelHold(); }
  for (let i = 0; i < 140 && !await fixture.queue.canResumePersisted(cancelled.id); i++) await delay(25);
  const recovery = await json<ComicRender>("/renders/" + cancelled.id + "/recover", "POST", {}, 202);
  assert.equal(recovery.id, cancelled.id);
  const savedAgain = await ready(recovery);
  assert.equal(savedAgain.editRevision, black.revision);
  assert.equal(savedAgain.durationMs, 12_700);
  fixture.skip();
  const missing = await exportClip(black.revision);
  assert.equal(missing.status, "pending");
  assert.equal((await json<ComicRender>("/renders/" + missing.id + "/recover", "POST", {}, 202)).id, missing.id);
  await json(path, "DELETE", { expectedRevision: black.revision });
  const recoveredAfterDelete = await ready(missing);
  assert.equal(recoveredAfterDelete.editRevision, black.revision);
  assert.equal((await status(original.id)).mediaId, noFade.mediaId);
  await json("/renders/" + original.id, "GET", undefined, 404, "fixture-two");
  const links = await json<{ url: string }>("/media/" + noFade.mediaId + "/links");
  assert.equal((await app.request(links.url, { headers: { Range: "bytes=0-31" } })).status, 206);
  const history = await json<ComicRenderHistory>("/renders?editId=" + fresh.id);
  assert.equal(history.entries.length, 6);
  assert.ok(history.entries.every(entry => entry.status === "ready" && entry.title === fresh.title));
  assert.equal((await json<ComicRenderHistory>("/renders?editId=" + fresh.id, "GET", undefined, 200, "fixture-two")).entries.length, 0);
  await json("/renders/" + original.id + "/download", "GET", undefined, 404, "fixture-two");
  await json("/renders/" + original.id + "/cancel", "POST", {}, 409);
  const link = await json<ComicRenderDownload>("/renders/" + original.id + "/download");
  const download = await app.request(link.url, { headers: { Range: "bytes=0-31" } });
  assert.equal(download.status, 206);
  assert.match(download.headers.get("Content-Disposition") ?? "", /attachment; filename="comic-/);
  assert.equal((await download.arrayBuffer()).byteLength, 32);
  assert.equal((await app.request(link.url.split("?")[0])).status, 404);
  await assert.rejects(pool.query("DELETE FROM lot_comic_drama.cd_media WHERE id=$1", [seed.b1.mediaId]), { code: "23503" });

  for (const [result, length] of [[noFade, 13.2], [fade, 12.7], [repeat, 12.7], [blackFade, 12.7]] as const) {
    const info = await inspectMedia(result.file);
    assert.deepEqual([info.width, info.height, info.fps], [1080, 1920, 30]);
    assert.ok(info.audio && info.video && Math.abs(info.duration - length) <= 1 / 30, JSON.stringify(info));
    const codecs = await mediaProcess(ffprobe(), ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", result.file]);
    assert.deepEqual(codecs.trim().split("\n"), ["h264", "aac"]);
  }
  const fingerprint = (file: string) => mediaProcess(ffmpeg(), ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
  assert.equal(await fingerprint(fade.file), await fingerprint(repeat.file));
  const center = async (file: string, second: number, pathName: string) => {
    const frame = join(root, pathName + ".png");
    await mediaProcess(ffmpeg(), ["-v", "error", "-ss", String(second), "-i", file, "-vf", "crop=2:2:540:960", "-frames:v", "1", frame]);
    return await sharp(frame).raw().toBuffer();
  };
  const blue = await center(noFade.file, 3, "first");
  const red = await center(noFade.file, 7, "second");
  const middle = await center(fade.file, 5.75, "blend");
  const dark = await center(blackFade.file, 5.75, "black");
  assert.ok(blue[2] > 200 && red[0] > 200 && middle[0] > 60 && middle[2] > 60 && dark[0] + dark[2] < (middle[0] + middle[2]) * 0.5,
    JSON.stringify({ blue: [...blue], red: [...red], middle: [...middle], dark: [...dark] }));
  for (const [index, time] of [0.6, 2.6, 4.6].entries()) {
    const name = join(root, `subtitle-${index}.png`);
    await mediaProcess(ffmpeg(), ["-v", "error", "-ss", String(time), "-i", noFade.file, "-vf", "crop=1080:600:0:1320", "-frames:v", "1", name]);
    const pixels = await sharp(name).removeAlpha().raw().toBuffer();
    let glyph = 0;
    for (let i = 0; i < pixels.length; i += 3) if (pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220) glyph++;
    assert.ok(glyph > 100, `subtitle ${index + 1} did not contain visible glyphs`);
  }
  const pcm = join(root, "mix.pcm");
  await mediaProcess(ffmpeg(), ["-v", "error", "-i", fade.file, "-vn", "-ar", "8000", "-ac", "1", "-f", "s16le", pcm]);
  const samples = await readFile(pcm);
  function tone(start: number, hz: number) {
    let re = 0, im = 0;
    for (let index = 0; index < 1600; index++) {
      const sample = samples.readInt16LE((Math.round(start * 8000) + index) * 2);
      const phase = 2 * Math.PI * hz * index / 8000;
      re += sample * Math.cos(phase);
      im += sample * Math.sin(phase);
    }
    return Math.hypot(re, im) / 800;
  }
  assert.ok(tone(1.2, 750) > tone(1.2, 660) * 2 && tone(1.2, 330) > 500);
  assert.ok(tone(6.1, 990) > 700 && tone(8.1, 660) > 200 && tone(8.1, 330) < 100);
  if (process.env.COMIC_RENDER_FIXTURE_OUTPUT) await copyFile(fade.file, process.env.COMIC_RENDER_FIXTURE_OUTPUT);
  const repeatPath = "/renders/" + repeat.id;
  const repeatLink = await json<ComicRenderDownload>(repeatPath + "/download");
  const repeatPreview = await json<ComicRenderDownload>(repeatPath + "/download?inline=1");
  assert.equal((await app.request(repeatPreview.url, { headers: { Range: "bytes=0-31" } })).headers.get("Content-Disposition"), "inline");
  await json(repeatPath, "DELETE", undefined, 404, "fixture-two");
  assert.deepEqual(await Promise.all([1, 2].map(() => json(repeatPath, "DELETE"))), [{ ok: true }, { ok: true }]);
  await json(repeatPath, "GET", undefined, 404);
  await json(repeatPath + "/download", "GET", undefined, 404);
  assert.equal((await app.request(repeatLink.url)).status, 404);
  assert.equal((await app.request(repeatPreview.url)).status, 404);
  await assert.rejects(stat(repeat.file), { code: "ENOENT" });
  assert.equal((await json<ComicRenderHistory>("/renders?editId=" + fresh.id)).entries.length, 5);
  await json(path + "/render", "POST", { expectedRevision: changed.revision, requestId: await pool.query<{ request_id: string }>(
    "SELECT request_id FROM lot_comic_drama.cd_renders WHERE id=$1", [repeat.id],
  ).then(result => result.rows[0].request_id) }, 404);
  assert.equal((await status(fade.id)).mediaId, fade.mediaId);
  assert.equal((await media.renderSource(owner, seed.b1.mediaId, "video")).durationMs, seed.b1.durationMs);

  const savedOutput = await json<{ id: string }>("/materials/from-media", "POST",
    { mediaId: savedAgain.mediaId, material: { kind: "other", name: "W10 复用导出成片", categoryKey: null, tags: [] } }, 201);
  const sharedLink = await json<ComicRenderDownload>("/renders/" + savedAgain.id + "/download");
  await json("/renders/" + savedAgain.id, "DELETE");
  assert.equal((await app.request(sharedLink.url)).status, 404);
  await json("/materials/" + savedOutput.id + "/versions");
  assert.equal((await stat(savedAgain.file)).isFile(), true);

  const renders = new PgComicRenders(pool);
  const deferred = await renders.remove(owner, blackFade.id);
  assert.ok(deferred);
  await renders.purgeDeletedFile(deferred, async () => { throw new Error("Fixture file cleanup failed"); });
  assert.equal((await stat(blackFade.file)).isFile(), true);
  await json("/renders/" + blackFade.id, "GET", undefined, 404);
  await renders.purgeDeletedFiles(key => media.removeRenderFile(key));
  await assert.rejects(stat(blackFade.file), { code: "ENOENT" });
  console.log("PASS completed export deletion: authorization, idempotency, stale link revocation, file cleanup and reused material retention");
  console.log("PASS W9 PG/Redis/FFmpeg: freeze, replay, private Range, retention, 13.2s cut, 12.7s fades, three subtitles and four audio sources");
  console.log("PASS W10 PG/Redis/FFmpeg: active cancel, safe same-job recovery, lost dispatch, detached history, private attachment and original revision");
}
