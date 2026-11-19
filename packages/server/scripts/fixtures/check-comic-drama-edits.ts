import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { ProviderError, type SpeechRequest } from "@lot-agent/core";
import {
  COMIC_DRAMA_API_ROOT, comicVideoItem, layoutComicTimeline, type ComicDramaDetail, type ComicEdit, type ComicSpeechLines, type ComicSpeechTake,
} from "@lot-agent/core/comic-drama";
import { createComicEditRoutes } from "../../src/comic-drama/edit-routes.js";
import { PgComicEdits } from "../../src/comic-drama/edit-repository.js";
import { ComicEditSpeech } from "../../src/comic-drama/edit-speech.js";
import { insertComicMedia } from "../../src/comic-drama/library-repository.js";
import { libraryTransaction } from "../../src/comic-drama/library-db.js";
import type { ComicMediaLibrary } from "../../src/comic-drama/media-library.js";
import type { PgComicDramaRepository } from "../../src/comic-drama/repository.js";
import { ffmpeg, mediaProcess } from "../../src/marketing-video/media.js";

type App = Hono<{ Variables: { userId: string } }>;
export async function mountComicEdits(app: App, pool: Pool, media: ComicMediaLibrary, root: string, owner: string, accepting?: () => void) {
  const wav = join(root, "w8.wav");
  await mediaProcess(ffmpeg(), ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=750:duration=1", "-c:a", "pcm_s16le", wav]);
  const audio = new Uint8Array(await readFile(wav));
  const calls: SpeechRequest[] = [];
  const cloneId = randomUUID();
  const state = { voiceId: "fixture-owned-voice-v1" };
  async function synthesize(request: SpeechRequest) {
    calls.push(request);
    if (request.text.includes("unknown")) throw new ProviderError("speech", "create", "TRANSPORT_ERROR");
    return { audio, mime: "audio/wav", gatewayRequestId: "fixture-speech" };
  }
  const repo = new PgComicEdits(pool);
  const speech = new ComicEditSpeech(pool, repo, media, {
    presetModel: "fixture-tts",
    ownerSpeech: async () => ({ synthesize }),
    clones: {
      list: async caller => caller === owner ? [{ id: cloneId, title: "W8 authorized voice" }] : [],
      ready: async (caller, id) => {
        if (caller !== owner || cloneId !== id) throw new Error("Not found");
        return { targetModel: "fixture-clone", voiceId: state.voiceId };
      },
      speak: async (caller, voice, request) => {
        assert.equal(caller, owner);
        return synthesize({ ...request, model: voice.targetModel, voice: voice.voiceId, format: "wav" });
      },
    },
  });
  app.route(COMIC_DRAMA_API_ROOT, createComicEditRoutes(repo, speech, accepting));
  return { calls, cloneId, state };
}

export async function verifyComicEdits(app: App, pool: Pool, seriesRepo: PgComicDramaRepository, media: ComicMediaLibrary,
  root: string, owner: string, other: string, fixture: Awaited<ReturnType<typeof mountComicEdits>>) {
  const request = (path: string, method = "GET", data?: unknown, token = "fixture-one") => app.request(COMIC_DRAMA_API_ROOT + path, {
    method, body: data === undefined ? undefined : JSON.stringify(data),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  async function json<T>(path: string, method = "GET", data?: unknown, expected = 200, token = "fixture-one"): Promise<T> {
    const response = await request(path, method, data, token);
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  const lineA = randomUUID(), lineB = randomUUID();
  const lines = [
    { id: lineA, speaker: "林", text: "第一句台词", speed: 1.2, emotionKey: "calm" },
    { id: lineB, speaker: null, text: "第二句台词", speed: 1, emotionKey: null },
  ];
  async function episode(caller: string, title: string) {
    const { series } = await seriesRepo.create(caller, { title, aspectRatio: "9:16", styleKey: "webtoon", videoModel: null });
    const { clips: [clip] } = await seriesRepo.addClip(caller, series.id, series.revision);
    return { series, clip };
  }
  let a = await episode(owner, "W8 原剧集");
  const b = await episode(owner, "W8 跨集素材");
  const foreign = await episode(other, "W8 私有外部");
  const currentA = await seriesRepo.saveClip(owner, a.series.id, a.clip.id, { expectedRevision: a.clip.revision, draft: { ...a.clip.draft, lines } });
  a = { series: { ...a.series, revision: currentA.seriesRevision }, clip: currentA.clip };

  async function makeVideo(seconds: number) {
    const path = join(root, `w8-${seconds}.mp4`);
    const color = seconds === 6 ? "blue" : seconds === 8 ? "red" : "green";
    const audio = seconds === 6 ? ["-f", "lavfi", "-i", "sine=frequency=330:duration=6", "-c:a", "aac"] : [];
    await mediaProcess(ffmpeg(), ["-v", "error", "-f", "lavfi", "-i", `color=${color}:size=320x568:rate=${seconds === 8 ? 25 : 24}:d=${seconds}`,
      ...audio, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-threads", "1", path]);
    return new Uint8Array(await readFile(path));
  }
  const [six, eight, five] = await Promise.all([makeVideo(6), makeVideo(8), makeVideo(5)]);
  async function done(caller: string, ep: typeof a, version: number, body: Uint8Array) {
    const take = randomUUID();
    const batch = randomUUID(), task = randomUUID();
    const input = { mode: "references", modelId: "fixture-video", aspectRatio: "9:16", clipRevision: ep.clip.revision };
    const file = await media.upload(new Request("http://fixture.invalid/video", { method: "POST",
      headers: { "Content-Type": "video/mp4" }, body: new Uint8Array(body) }), caller, "generated-video",
    file => libraryTransaction(pool, async db => {
      await insertComicMedia(db, file);
      await db.query(`INSERT INTO tasks(id,type,input,user_id,status,queue_name)
        VALUES($1,'comic-drama.video','{}',$2,'succeeded','lot-marketing-video')`, [task, caller]);
      await db.query(`INSERT INTO lot_comic_drama.cd_generation_requests(id,owner_id,series_id,frozen,expires_at,confirmed_at,task_id)
        VALUES($1,$2,$3,'{}',now(),now(),$4)`, [batch, caller, ep.series.id, task]);
      await db.query(`INSERT INTO lot_comic_drama.cd_takes(id,owner_id,request_id,target_id,target_key,slot,input,status,media_id,completed_at,video_version)
        VALUES($1,$2,$3,$4,$5,0,$6,'ready',$7,now(),$8)`, [take, caller, batch, ep.clip.id, "video:" + ep.clip.id, input, file.id, version]);
      return file;
    }));
    return { takeId: take, mediaId: file.id, durationMs: file.durationMs! };
  }
  const a1 = await done(owner, a, 1, six), b1 = await done(owner, b, 1, eight), b2 = await done(owner, b, 2, five);
  const otherTake = await done(other, foreign, 1, six);
  const adopt = (ep: typeof a, take: { takeId: string }) => pool.query("UPDATE lot_comic_drama.cd_clips SET adopted_video_take_id=$2 WHERE id=$1",
    [ep.clip.id, take.takeId]);
  await adopt(a, a1);
  await adopt(b, b1);
  const initial = await json<ComicEdit>("/edits", "POST", { title: "W8 预告", seriesId: a.series.id }, 201);
  const path = "/edits/" + initial.id;
  const added = { ...comicVideoItem(randomUUID(), b1), inMs: 400, outMs: 7600 };
  const timeline = { ...initial.timeline, video: [...initial.timeline.video, added] };
  assert.equal(initial.timeline.video[0].takeId, a1.takeId);
  assert.equal(layoutComicTimeline(timeline).durationMs, 13_200);
  const fields = { title: initial.title, expectedRevision: initial.revision, timeline };
  await json(path, "PATCH", { ...fields, timeline: { ...timeline, video: [comicVideoItem(randomUUID(), otherTake)] } }, 404);
  await json(path, "PATCH", { ...fields, timeline: { ...timeline, video: [{ ...added, sourceDurationMs: 8100 }] } }, 409);
  const writers = await Promise.all([request(path, "PATCH", fields), request(path, "PATCH", fields)]);
  assert.deepEqual(writers.map(response => response.status).sort(), [200, 409]);
  const saved = await json<ComicEdit>(path);
  assert.equal(saved.timeline.video[1].takeId, b1.takeId);
  await json(path, "GET", undefined, 404, "fixture-two");
  await json(path, "DELETE", { expectedRevision: saved.revision }, 404, "fixture-two");

  await adopt(b, b2);
  const unchanged = await json<ComicEdit>(path);
  assert.equal(unchanged.timeline.video[1].takeId, b1.takeId);
  assert.equal(unchanged.sources.find(source => source.takeId === b1.takeId)?.adopted?.takeId, b2.takeId);
  const replacePath = path + "/items/" + added.id + "/replace";
  await json(replacePath, "POST", { expectedRevision: saved.revision, takeId: b2.takeId }, 409);
  const replaced = await json<ComicEdit>(replacePath, "POST", { expectedRevision: saved.revision, takeId: b2.takeId, outMs: 5000 });
  assert.deepEqual(replaced.timeline.video[1], { ...added, takeId: b2.takeId, sourceDurationMs: 5000, outMs: 5000 });
  const indexed = await pool.query<{ take_id: string }>("SELECT take_id FROM lot_comic_drama.cd_edit_takes WHERE edit_id=$1 ORDER BY take_id", [initial.id]);
  assert.deepEqual(indexed.rows.map(row => row.take_id), [a1.takeId, b2.takeId].sort());

  const { id: role } = await json<{ id: string }>("/characters", "POST",
    { name: "林", age: "", personality: "", appearance: "", aliases: [], tags: [], roleKey: "lead" }, 201);
  const { id: outfit } = await json<{ id: string }>("/characters/" + role + "/outfits", "POST", { name: "W8 outfit" }, 201);
  const current = await json<ComicDramaDetail>("/series/" + a.series.id);
  await json("/series/" + a.series.id + "/cast", "POST", { expectedRevision: current.series.revision, characterId: role, outfitId: outfit }, 201);
  const bind = "/characters/" + role + "/voice";
  await json(bind, "PUT", { kind: "clone", itemId: fixture.cloneId, authorized: false }, 400);
  await json(bind, "PUT", { kind: "clone", itemId: randomUUID(), authorized: true }, 404);
  await json(bind, "PUT", { kind: "clone", itemId: fixture.cloneId, authorized: true }, 404, "fixture-two");
  await json(bind, "PUT", { kind: "clone", itemId: fixture.cloneId, authorized: true });
  const base = path + "/items/" + initial.timeline.video[0].id + "/lines";
  let dialogue = await json<ComicSpeechLines>(base);
  assert.equal(dialogue.characters[0].id, role);
  const first = (line: string, voice: unknown, status = 200) => json<ComicSpeechTake>(base + "/" + line + "/speech", "POST",
    { expectedRevision: replaced.revision, expectedClipRevision: dialogue.clipRevision, voice }, status);
  const preset = { kind: "preset", preset: "alloy" };
  const clone = { kind: "character", characterId: role };
  const takeA = await first(lineA, clone), takeB = await first(lineB, preset);
  assert.equal(takeA.durationMs, 1000);
  assert.equal((await first(lineA, clone)).mediaId, takeA.mediaId);
  assert.equal((await first(lineB, preset)).mediaId, takeB.mediaId);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0].voice, "fixture-owned-voice-v1");
  assert.equal(fixture.calls[0].speed, 1.2);
  const editedClip = await seriesRepo.saveClip(owner, a.series.id, a.clip.id, { expectedRevision: dialogue.clipRevision!,
    draft: { ...a.clip.draft, lines: [{ ...lines[0], text: "改过的台词" }, lines[1]] } });
  await first(lineA, clone, 409);
  dialogue = await json<ComicSpeechLines>(base);
  const changed = await first(lineA, clone);
  assert.notEqual(changed.mediaId, takeA.mediaId);
  assert.equal((await first(lineB, preset)).mediaId, takeB.mediaId);
  assert.equal(fixture.calls.length, 3);
  fixture.state.voiceId = "fixture-owned-voice-v2";
  await first(lineA, clone, 404);
  assert.equal(fixture.calls.length, 3);
  await seriesRepo.saveClip(owner, a.series.id, a.clip.id, { expectedRevision: editedClip.clip.revision,
    draft: { ...editedClip.clip.draft, lines: [{ ...lines[0], text: "unknown speech" }, lines[1]] } });
  dialogue = await json<ComicSpeechLines>(base);
  await first(lineA, preset, 409); await first(lineA, preset, 409);
  assert.equal(fixture.calls.length, 4);
  const voice = { ...preset, preset: "nova" };
  const spoken = await Promise.all([1, 2].map(() => request(base + "/" + lineB + "/speech", "POST", {
    expectedRevision: replaced.revision, expectedClipRevision: dialogue.clipRevision, voice,
  })));
  assert.equal(spoken[0].ok || spoken[1].ok, true);
  assert.ok(spoken.every(response => response.ok || response.status === 409));
  assert.equal((await first(lineB, voice)).cached, true);
  assert.equal(fixture.calls.length, 5, "concurrent uncached requests claim a single provider call");

  const disposable = await json<ComicEdit>("/edits", "POST", { title: "W8 disposable" }, 201);
  await json("/edits/" + disposable.id, "DELETE", { expectedRevision: disposable.revision });
  await json("/edits/" + disposable.id, "GET", undefined, 404);
  console.log("PASS W8 PG/HTTP: exact cross-series source, 13.2s trim, CAS, adoption pinning, reference indexes, voice authorization and cache");
  return { a1, b1, b2, projectId: initial.id, speechMediaId: takeB.mediaId };
}
