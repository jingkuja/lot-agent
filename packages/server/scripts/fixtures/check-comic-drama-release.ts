import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import type { Hono } from "hono";
import type { Pool } from "pg";
import {
  COMIC_DRAMA_API_ROOT, comicVideoItem, type ComicDirectorProposal, type ComicDirectorState, type ComicDramaDetail, type ComicEdit,
  type ComicGenerationQuote, type ComicImageRequest, type ComicLibraryPage, type ComicMaterial, type ComicRender, type ComicRenderDownload,
  type ComicSpeechLines, type ComicSpeechTake,
} from "@lot-agent/core/comic-drama";
import type { mountComicGenerationFixture } from "./check-comic-drama-generation.js";
import { w6Seedance20 } from "./check-comic-drama-video.js";

export async function verifyComicRelease(app: Hono<{ Variables: { userId: string } }>, pool: Pool, seriesId: string,
  generation: Awaited<ReturnType<typeof mountComicGenerationFixture>> | undefined, config: NodeJS.ProcessEnv, owner: string,
  otherSource: { takeId: string; durationMs: number }) {
  const series = "/series/" + seriesId;
  const path = series + "/director";
  async function request<T>(route: string, method = "GET", fields?: unknown, status = 200, token = "fixture-one") {
    const response = await app.request(COMIC_DRAMA_API_ROOT + route, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: fields === undefined ? undefined : JSON.stringify(fields) });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${route} ${JSON.stringify(data).slice(0, 200)}`);
    return data as T;
  }
  const current = () => request<ComicDramaDetail>(series);
  const before = await current();
  const add = await request<{ seriesRevision: number; clips: ComicDramaDetail["clips"] }>(series + "/clips", "POST",
    { expectedRevision: before.series.revision }, 201);
  async function propose(text: string, expectedRevision: number, action: "breakdown" | "sequel" = "breakdown") {
    return request<ComicDirectorProposal>(path + "/proposals", "POST", { expectedRevision, requestId: randomUUID(),
      text, action, language: "zh", mode: "paste" });
  }
  const decide = (proposal: ComicDirectorProposal, decision: "append" | "replace" | "sequel", status = 200) =>
    request<ComicDirectorProposal>(path + "/proposals/" + proposal.id + "/apply", "POST", { expectedRevision: proposal.baseRevision, decision }, status);
  assert.equal((await propose("fixture empty shot", add.seriesRevision)).status, "failed");
  assert.equal((await propose("fixture unauthorized tool", add.seriesRevision)).status, "failed");
  assert.equal((await propose("fixture truncated", add.seriesRevision)).status, "failed");
  assert.equal((await propose("fixture filtered", add.seriesRevision)).status, "failed");
  const adapterA = await propose("fixture native tool adapter", add.seriesRevision);
  const adapterB = await propose("fixture JSON adapter", add.seriesRevision);
  const adapterC = await propose("fixture anthropic tool", add.seriesRevision);
  assert.equal(adapterA.status, "ready");
  assert.equal(adapterB.status, "ready");
  assert.equal(adapterC.status, "ready");
  assert.deepEqual(adapterA.proposal?.clips?.map(clip => clip.scene), adapterB.proposal?.clips?.map(clip => clip.scene));
  assert.deepEqual(adapterA.proposal?.clips?.map(clip => clip.scene), adapterC.proposal?.clips?.map(clip => clip.scene));
  assert.equal(adapterA.proposal?.clips?.[0].shots.length, 1);
  assert.equal((await current()).clips.length, 1);
  const [first, duplicate] = await Promise.all([decide(adapterA, "append"), decide(adapterA, "append")]);
  assert.equal(first.appliedRevision, duplicate.appliedRevision);
  await decide(adapterA, "replace", 409);
  await decide(adapterB, "replace", 409);
  const amended = await current();
  assert.deepEqual(amended.clips.map(clip => clip.draft.scene), ["", "W11 雨夜相逢"]);
  assert.equal(amended.clips[0].id, add.clips[0].id);
  const role = (index: number, data: Record<string, unknown>, status = 200) =>
    request<{ characterId: string | null; revision: number }>(path + "/proposals/" + adapterA.id + "/roles/" + index, "POST", data, status);
  assert.equal(adapterA.proposal?.roles[1].candidates.length, 2);
  const candidate = adapterA.proposal!.roles[1].candidates[0];
  const outfit = await request<{ id: string }>("/characters/" + candidate.id + "/outfits", "POST", { name: "营业服" }, 201);
  await role(1, { choice: "existing", expectedRevision: amended.series.revision, characterId: randomUUID(), outfitId: outfit.id }, 404);
  const adopted = await role(1, { choice: "existing", expectedRevision: amended.series.revision, characterId: candidate.id, outfitId: outfit.id });
  const created = await role(2, { choice: "new", expectedRevision: adopted.revision, outfitName: "夜行装" });
  assert.equal((await role(2, { choice: "new", expectedRevision: adopted.revision, outfitName: "夜行装" })).characterId, created.characterId);
  await role(0, { choice: "skip", expectedRevision: created.revision });
  assert.equal((await current()).cast.length, 2);
  const replacement = await propose("用 JSON 阶段交付新画面", created.revision);
  const replaced = await decide(replacement, "replace");
  const live = await current();
  assert.equal(live.clips.length, 1);
  assert.notEqual(live.clips[0].id, amended.clips[1].id);
  assert.equal(live.clips[0].draft.scene, "W11 雨夜相逢");
  assert.equal((await propose("fixture sequel truncated", replaced.appliedRevision!, "sequel")).status, "failed");
  const sequelJson = await propose("fixture sequel JSON", replaced.appliedRevision!, "sequel");
  assert.equal(sequelJson.status, "ready");
  const sequel = await propose("下一集继续故事", replaced.appliedRevision!, "sequel");
  assert.equal(sequel.status, "ready");
  const next = await decide(sequel, "sequel");
  const sameNext = await decide(sequel, "sequel");
  assert.equal(next.sequelId, sameNext.sequelId);
  const nextSeries = await request<ComicDramaDetail>("/series/" + next.sequelId);
  assert.equal(nextSeries.series.parentId, seriesId);
  assert.equal(nextSeries.cast.length, 2);
  assert.ok(nextSeries.script?.content);
  await request(path, "GET", undefined, 404, "fixture-two");
  console.log("PASS W11 director: isolated tool/JSON adapters, invalid scenes, injected tools denied, append/replace CAS, explicit characters and sequel replay");

  if (!generation) return;
  const sends = generation.counts.submits;
  const quote = await request<ComicGenerationQuote>(path + "/generation-preview", "POST", { mode: "keyframe",
    expectedSeriesRevision: live.series.revision, targets: [{ clipId: live.clips[0].id, expectedRevision: live.clips[0].revision }] });
  assert.ok(quote.confirmationId);
  assert.equal(generation.counts.submits, sends);
  assert.equal((await request<ComicDirectorState>(path)).quotes?.[0].confirmed, false);
  const confirm = (status = 202) => request<ComicImageRequest>(series + "/generate", "POST", { confirmationId: quote.confirmationId }, status);
  config.COMIC_DRAMA_PILOT_OWNER_IDS = owner;
  assert.equal((await request<ComicDirectorState>(path)).quotes?.length, 1);
  assert.equal((await app.request(COMIC_DRAMA_API_ROOT + "/series", { headers: { Authorization: "Bearer fixture-two" } })).status, 404);
  delete config.COMIC_DRAMA_PILOT_OWNER_IDS;
  config.COMIC_DRAMA_WRITES_PAUSED = "1";
  assert.equal((await confirm(503) as unknown as { code: string }).code, "COMIC_SUBMISSIONS_PAUSED");
  await request(path + "/proposals", "POST", { requestId: randomUUID(), expectedRevision: live.series.revision,
    mode: "paste", language: "zh", text: "paused" }, 503);
  assert.equal(generation.counts.submits, sends);
  delete config.COMIC_DRAMA_WRITES_PAUSED;
  const queued = await confirm();
  config.COMIC_DRAMA_WRITES_PAUSED = "1";
  config.COMIC_DRAMA_ENTRY_HIDDEN = "1";
  const replay = await confirm();
  assert.equal(replay.taskId, queued.taskId);
  assert.equal((await request<ComicDirectorState>(path)).quotes?.[0].confirmed, true);
  const snapshot = await request<ComicDirectorState>(path);
  const message = await pool.query<{ status: string }>("SELECT metadata->>'status' AS status FROM messages WHERE conversation_id=$1 AND metadata->>'comicDirectorQuoteId'=$2",
    [snapshot.conversationId, quote.confirmationId]);
  assert.equal(message.rows[0]?.status, "confirmed");
  for (let i = 0; generation.counts.submits === sends && i < 200; i++) await delay(25);
  assert.equal(generation.counts.submits, sends + 1);
  const feature = await app.request("/api/public/product", { headers: { Authorization: "Bearer fixture-one" } });
  assert.equal((await feature.json()).comicDramaEnabled, false);
  delete config.COMIC_DRAMA_ENTRY_HIDDEN;
  delete config.COMIC_DRAMA_WRITES_PAUSED;
  console.log("PASS W11/W12 release: persisted confirmation, no submit before approval, pilot, pause with replay, hidden entry with running worker, reopen");

  async function settled(id: string) {
    for (let i = 0; i < 600; i++) {
      const job = await request<ComicImageRequest>("/generation-requests/" + id);
      if (!job.active) return job;
      await delay(100);
    }
    throw new Error("Release video task did not settle");
  }
  const frame = (await settled(queued.id)).takes[0];
  assert.equal(frame.state, "ready");
  const { id: _id, parentId: _parent, archivedAt: _archive, revision, ...fields } = (await current()).series;
  await request(series, "PATCH", { ...fields, expectedRevision: revision, videoModel: w6Seedance20 });
  const clip = live.clips[0], clipPath = series + "/clips/" + clip.id;
  const approved = await request<{ ok: true; selectionRevision: number }>(clipPath + "/keyframe/confirm", "POST", {
    expectedClipRevision: clip.revision, expectedSelectionRevision: clip.selectionRevision ?? 1, keyframeTakeId: frame.id,
  });
  const videoQuote = await request<ComicGenerationQuote>(path + "/generation-preview", "POST", {
    expectedSeriesRevision: (await current()).series.revision, mode: "from_keyframe", targets: [{ clipId: clip.id, expectedRevision: clip.revision }],
  });
  assert.ok(videoQuote.confirmationId);
  const submitted = await request<ComicImageRequest>(series + "/generate", "POST", { confirmationId: videoQuote.confirmationId }, 202);
  const video = (await settled(submitted.id)).takes[0];
  assert.equal(video.state, "ready");
  await request(clipPath + "/video/adopt", "POST", {
    takeId: video.id, expectedClipRevision: clip.revision, expectedSelectionRevision: approved.selectionRevision,
  });
  const edit = await request<ComicEdit>("/edits", "POST", { title: "W12 整集验收", seriesId }, 201);
  const firstItem = edit.timeline.video[0], editPath = "/edits/" + edit.id;
  assert.equal(firstItem.takeId, video.id);
  const speaker = editPath + "/items/" + firstItem.id + "/lines";
  const lines = await request<ComicSpeechLines>(speaker);
  assert.equal(lines.lines[0].text, "营业到凌晨。");
  const speech = await request<ComicSpeechTake>(speaker + "/" + lines.lines[0].id + "/speech", "POST", {
    expectedRevision: edit.revision, expectedClipRevision: lines.clipRevision, voice: { kind: "preset", preset: "alloy" },
  });
  const music = (await request<ComicLibraryPage<ComicMaterial>>("/materials?kind=music")).entries.find(item => item.name === "W9 配乐样例");
  assert.ok(music);
  const audio = (mediaId: string, durationMs: number, volume: number, loop: boolean) => ({
    id: randomUUID(), mediaId, anchor: { kind: "timeline", offsetMs: 0 }, durationMs, volume, loop, sourceInMs: 0, fadeInMs: 0, fadeOutMs: 250,
  });
  const updated = await request<ComicEdit>(editPath, "PATCH", { title: edit.title, expectedRevision: edit.revision, timeline: {
    ...edit.timeline, video: [firstItem, { ...comicVideoItem(randomUUID(), otherSource), inMs: 400, outMs: 7600,
      transitionIn: { kind: "crossfade", durationMs: 500 } }],
    voice: [audio(speech.mediaId, 1000, 1, false)], music: [audio(music.media.id, 10_700, 0.3, true)],
    subtitles: ["营业到凌晨", "Open until dawn", "Buka hingga fajar"].map((text, index) => ({
      id: randomUUID(), anchor: { kind: "timeline", offsetMs: index * 2400 }, durationMs: 1800, text,
    })),
  } });
  const renderInput = { expectedRevision: updated.revision, requestId: randomUUID() };
  config.COMIC_DRAMA_WRITES_PAUSED = "1";
  await request(editPath + "/render", "POST", renderInput, 503);
  delete config.COMIC_DRAMA_WRITES_PAUSED;
  const render = await request<ComicRender>(editPath + "/render", "POST", renderInput, 202);
  config.COMIC_DRAMA_WRITES_PAUSED = "1";
  assert.equal((await request<ComicRender>(editPath + "/render", "POST", renderInput, 202)).id, render.id);
  let result = render;
  for (let i = 0; result.status === "pending" || result.status === "running"; i++) {
    if (i >= 600) throw new Error("Release render did not settle");
    await delay(100);
    result = await request<ComicRender>("/renders/" + render.id);
  }
  assert.equal(result.status, "ready");
  assert.equal(result.durationMs, 10_700);
  const download = await request<ComicRenderDownload>("/renders/" + render.id + "/download");
  const file = await app.request(download.url);
  assert.equal(file.status, 200);
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.toString("ascii", 4, 8), "ftyp");
  if (process.env.COMIC_RELEASE_FIXTURE_OUTPUT) await writeFile(process.env.COMIC_RELEASE_FIXTURE_OUTPUT, bytes);
  delete config.COMIC_DRAMA_WRITES_PAUSED;
  const newPlan = await propose("替换有已采用视频的分镜", (await current()).series.revision);
  await decide(newPlan, "replace");
  assert.equal((await request<ComicEdit>(editPath)).timeline.video[0].takeId, video.id);
  assert.ok((await request<ComicRender>("/renders/" + render.id)).mediaId);
  console.log("PASS W12 full episode: director → keyframe → video adoption → speech/music/subtitles → 10.7s private MP4; replacement retains previous take");
}
