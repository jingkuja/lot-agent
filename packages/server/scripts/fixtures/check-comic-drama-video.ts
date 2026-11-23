import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { OpenaiVideoAdapter, ProviderError, type VideoGenerationProvider } from "@lot-agent/core";
import {
  COMIC_DRAMA_API_ROOT, type ComicDramaClip, type ComicDramaContent, type ComicDramaDetail, type ComicGenerationMode,
  type ComicGenerationQuote, type ComicGenerationRequest, type ComicVideoHistory, type ComicVideoReceipt, type ComicVideoTake,
} from "@lot-agent/core/comic-drama";
import type { ComicMediaLibrary } from "../../src/comic-drama/media-library.js";
import { runComicVideoGeneration } from "../../src/comic-drama/video-worker.js";
import { PgComicGeneration } from "../../src/comic-drama/generation-repository.js";
import { queryComicDramaReport } from "../../src/comic-drama/operations-report.js";
import type { BullmqJobQueue } from "../../src/jobs/bullmq-queue.js";
import { COMIC_VIDEO_TASK, MARKETING_VIDEO_QUEUE } from "../../src/jobs/task-queues.js";
import { ffmpeg, mediaProcess } from "../../src/marketing-video/media.js";
import { comicFixturePng } from "./check-comic-drama-library.js";

export const w6Grok = "grok-imagine-video-1.5";
export const w6Kling = "kling-video-v3-omni";

export async function mountComicVideoFixture({ pool, media, owner, queue, root }: {
  pool: Pool; media: ComicMediaLibrary; owner: string; queue: BullmqJobQueue; root: string;
}) {
  const outfile = join(root, "w6-fake-video.mp4");
  await mediaProcess(ffmpeg(), ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0x456b90:s=320x568:r=24:d=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", "-movflags", "+faststart", outfile], { timeoutMs: 15_000 });
  const body = await readFile(outfile);
  const accepted = new Map<string, string>();
  const submitted: { model: string; scene: string; request: Record<string, unknown> }[] = [];
  const polls: string[] = [];
  const downloads: string[] = [];
  const state = { disconnect: false, badDownload: false, expireDownload: false, waiting: false, releasePoll: false };
  const provider: VideoGenerationProvider = {
    async create(req) {
      const model = req.model ?? "";
      assert.ok([w6Grok, w6Kling].includes(model));
      const request = new OpenaiVideoAdapter().buildCreateBody(req, model) as Record<string, unknown>;
      const scene = /^Scene: (.+)\.$/m.exec(req.prompt)?.[1] ?? "";
      submitted.push({ model, scene, request });
      for (const ref of [req.first_frame, ...(req.input_reference ?? [])].filter(Boolean)) {
        const url = new URL(String(ref));
        assert.equal(url.origin, "https://comic-fixture.invalid");
        assert.match(url.pathname, /^\/api\/public\/comic-drama-media\//);
        assert.ok(url.searchParams.get("material_token"));
      }
      assert.equal(request.seconds, "4");
      assert.equal(request.ratio, "9:16");
      assert.equal(request.size, "720x1280");
      assert.deepEqual(request.metadata, { resolution: "720p" });
      assert.equal(request.generate_audio, false);
      if (scene === "W6 reject") {
        throw new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 502, gatewayRequestId: "fixture-rejected" });
      }
      if (scene === "W6 unknown") {
        throw new ProviderError("generation", "create", "TRANSPORT_ERROR", { gatewayRequestId: "fixture-unknown-video" });
      }
      const vendor = "fixture-video-" + submitted.length;
      accepted.set(vendor, scene);
      return { taskId: vendor, status: "queued", progress: 0, gatewayRequestId: "trace-" + vendor };
    },
    async poll(id, options) {
      assert.ok(accepted.has(id));
      const scene = accepted.get(id);
      polls.push(id);
      if (scene === "W6 interrupted" && state.disconnect) {
        state.disconnect = false;
        throw new Error("fixture poll interrupted after submission");
      }
      if (scene === "W6 cancel after submit" && !state.releasePoll) {
        state.waiting = true;
        await delay(10_000, undefined, { signal: options?.signal });
      }
      const count = polls.filter(vendor => vendor === id).length;
      return { status: "completed", progress: 100, url: `https://comic-fixture.invalid/video/${id}/${count}` };
    },
  };
  queue.process(COMIC_VIDEO_TASK, (job, control) => runComicVideoGeneration({
    pool, media, pollIntervalMs: 10, cancelIntervalMs: 25,
    provider: async user => { assert.equal(user, owner); return provider; },
    download: async url => {
      downloads.push(url);
      if (state.badDownload) { state.badDownload = false; throw new Error("fixture download interrupted"); }
      if (state.expireDownload) { state.expireDownload = false; throw Object.assign(new Error("fixture output expired"), { status: 403 }); }
      return { body, mime: "video/mp4" };
    },
  }, job, control.signal));
  return { submitted, polls, downloads, state, queue };
}

type FixtureApp = Hono<{ Variables: { userId: string } }>;
type Fixture = Awaited<ReturnType<typeof mountComicVideoFixture>>;

export async function verifyComicVideo(app: FixtureApp, pool: Pool, fixture: Fixture) {
  const { submitted, polls, downloads, state, queue } = fixture;
  const request = (path: string, method = "GET", data?: unknown, token = "fixture-one") => app.request(COMIC_DRAMA_API_ROOT + path, {
    method, body: data === undefined ? undefined : JSON.stringify(data),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  async function json<T>(path: string, method = "GET", data?: unknown, expected = 200): Promise<T> {
    const response = await request(path, method, data);
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${path} ${JSON.stringify(value)}`);
    return value as T;
  }
  async function until(check: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 250; i++) {
      if (await check()) return;
      await delay(25);
    }
    throw new Error("Fixture video timed out");
  }
  const read = (id: string) => json<ComicGenerationRequest>("/generation-requests/" + id);
  async function settled(id: string) {
    await until(async () => !(await read(id)).active);
    return read(id);
  }
  async function resume(run: ComicGenerationRequest, takeId: string) {
    await until(() => queue.canResumePersisted(run.taskId));
    await json(`/video-takes/${takeId}/recover`, "POST", {}, 202);
    return settled(run.id);
  }
  async function makeEpisode(title: string, model: string, scenes: string[]) {
    let detail = await json<ComicDramaDetail>("/series", "POST", { title, styleKey: "webtoon", aspectRatio: "9:16", videoModel: model }, 201);
    const path = "/series/" + detail.series.id;
    for (const scene of scenes) {
      const added = await json<ComicDramaContent>(path + "/clips", "POST", { expectedRevision: detail.series.revision }, 201);
      const clip = added.clips.at(-1)!;
      await json(path + "/clips/" + clip.id, "PATCH", { expectedRevision: clip.revision, draft: { ...clip.draft, scene, durationMs: 4000,
        shots: [{ id: randomUUID(), framingKey: "medium", movementKey: "fixed", description: "Studio scene", durationShare: 100 }] } });
      detail = await json<ComicDramaDetail>(path);
    }
    return { detail, path };
  }
  const targets = (clips: ComicDramaClip[], replaceAdopted = false) => clips.map(clip => ({
    clipId: clip.id, expectedRevision: clip.revision, replaceAdopted,
  }));
  const preview = (ep: Awaited<ReturnType<typeof makeEpisode>>, clips = ep.detail.clips, mode: ComicGenerationMode = "references",
    extras: Record<string, unknown> = {}) => json<ComicGenerationQuote>(ep.path + "/generation-preview", "POST", {
      expectedSeriesRevision: ep.detail.series.revision, targets: targets(clips), mode, ...extras,
    });
  const confirm = (ep: Awaited<ReturnType<typeof makeEpisode>>, quote: ComicGenerationQuote) =>
    json<ComicGenerationRequest>(ep.path + "/generate", "POST", { confirmationId: quote.confirmationId }, 202);
  const receipt = (id: string) => json<ComicVideoReceipt>(`/video-takes/${id}/receipt`);

  const ep = await makeEpisode("W6 video fixture", w6Grok, ["W6 ready", "W6 reject", "W6 unknown", "W6 interrupted"]);
  const [ready, rejected, unknown, interrupted] = ep.detail.clips;
  const waitingForFrame = await preview(ep, [ready], "from_keyframe");
  assert.equal(waitingForFrame.skipped[0].reason, "KEYFRAME_NOT_CONFIRMED");
  assert.equal(submitted.length, 0);
  const firstQuote = await preview(ep, [ready], "keyframe");
  const first = (await settled((await confirm(ep, firstQuote)).id)).takes[0];
  assert.equal(first.state, "ready");
  const clipPath = ep.path + "/clips/" + ready.id;
  const readySel1 = await json<{ ok: true; selectionRevision: number }>(clipPath + "/keyframe/confirm", "POST", {
    keyframeTakeId: first.id, expectedClipRevision: ready.revision, expectedSelectionRevision: ready.selectionRevision ?? 1,
  });
  const fromFrame = await preview(ep, [ready], "from_keyframe");
  assert.equal(fromFrame.totalMicros, 2_000_000);
  assert.equal(fromFrame.items[0].unit, "second");
  assert.equal(fromFrame.items[0].referenceVersions?.[0].mediaId, first.mediaId);
  assert.equal(submitted.length, 0, "Discarding a video preview makes no gateway call");
  const secondFrame = (await settled((await confirm(ep, await preview(ep, [ready], "keyframe"))).id)).takes[0];
  await json(clipPath + "/keyframe/confirm", "POST", {
    keyframeTakeId: secondFrame.id, expectedClipRevision: ready.revision, expectedSelectionRevision: ready.selectionRevision ?? 1,
  }, 409);
  const readySel2 = await json<{ ok: true; selectionRevision: number }>(clipPath + "/keyframe/confirm", "POST", {
    keyframeTakeId: secondFrame.id, expectedClipRevision: ready.revision, expectedSelectionRevision: readySel1.selectionRevision,
  });
  const stale = await json<{ code: string }>(ep.path + "/generate", "POST", { confirmationId: fromFrame.confirmationId }, 409);
  assert.equal(stale.code, "QUOTE_STALE");
  assert.equal(submitted.length, 0);

  const mixedQuote = await preview(ep, [ready, rejected, unknown]);
  const [created, duplicate] = await Promise.all([confirm(ep, mixedQuote), confirm(ep, mixedQuote)]);
  assert.equal(created.taskId, duplicate.taskId);
  assert.equal((await pool.query("SELECT queue_name FROM tasks WHERE id=$1", [created.taskId])).rows[0].queue_name, MARKETING_VIDEO_QUEUE);
  const mixed = await settled(created.id);
  assert.equal(mixed.kind, "video");
  const [good, bad, uncertain] = mixed.takes;
  assert.deepEqual(mixed.takes.map(take => take.state), ["ready", "failed", "unknown"]);
  assert.deepEqual(submitted.map(call => call.scene), ["W6 ready", "W6 reject", "W6 unknown"]);
  assert.ok(!("first_frame" in submitted[0].request) && !("input_reference" in submitted[0].request));
  assert.equal((await receipt(bad.id)).httpStatus, 502);
  assert.equal((await receipt(bad.id)).gatewayRequestId, "fixture-rejected");
  assert.equal((await receipt(uncertain.id)).gatewayRequestId, "fixture-unknown-video");
  assert.equal((await request(`/video-takes/${uncertain.id}/receipt`, "GET", undefined, "fixture-two")).status, 404);
  assert.equal((await request(`/video-takes/${uncertain.id}`)).status, 404, "unfinished takes cannot be picked as editing sources");
  assert.equal((await request(`/video-takes/${good.id}`, "GET", undefined, "fixture-two")).status, 404);
  const source = await json<ComicVideoTake & { taskId?: string }>(`/video-takes/${good.id}`);
  assert.equal(source.mediaId, good.mediaId);
  assert.equal(source.taskId, undefined);
  assert.equal((await request(`/video-takes/${uncertain.id}/recover`, "POST", {})).status, 409);
  assert.equal((await preview(ep, [unknown])).skipped[0].reason, "BUSY");
  await json(`/video-takes/${uncertain.id}/release`, "POST", { acknowledgePossibleCharge: true });
  assert.equal((await read(mixed.id)).takes[2].state, "released");
  assert.equal((await receipt(uncertain.id)).gatewayRequestId, "fixture-unknown-video");
  assert.ok((await preview(ep, [unknown])).confirmationId);
  assert.equal(submitted.length, 3);
  const opsReport = await queryComicDramaReport(pool, 24);
  const badReconcile = opsReport.toReconcile.find(row => row.take_id === bad.id);
  assert.ok(badReconcile, "502 VIDEO_GATEWAY_FAILED take must appear in reconciliation report");
  assert.equal(badReconcile.request_id, mixed.id);
  assert.equal(badReconcile.task_id, mixed.taskId);
  assert.equal(badReconcile.gateway_http_status, 502);
  assert.equal(badReconcile.error, "VIDEO_GATEWAY_FAILED");
  assert.equal(badReconcile.error_category, "gateway_5xx");
  assert.equal(badReconcile.gateway_request_id, "fixture-rejected");
  const releasedReconcile = opsReport.toReconcile.find(row => row.take_id === uncertain.id);
  assert.equal(releasedReconcile?.error_category, "released");
  assert.equal(releasedReconcile?.gateway_request_id, "fixture-unknown-video");

  await json(ep.path + `/clips/${rejected.id}/video/adopt`, "POST", {
    takeId: good.id, expectedClipRevision: rejected.revision, expectedSelectionRevision: rejected.selectionRevision ?? 1,
  }, 409);
  await json(clipPath + "/video/adopt", "POST", {
    takeId: good.id, expectedClipRevision: ready.revision, expectedSelectionRevision: readySel2.selectionRevision,
  });
  assert.equal((await preview(ep, [ready])).skipped[0].reason, "ALREADY_COMPLETE");
  assert.ok((await preview(ep, [ready], "references", { targets: targets([ready], true) })).confirmationId);
  const history = await json<ComicVideoHistory>("/videos?adopted=true&seriesQuery=W6");
  assert.deepEqual(history.entries.map(item => item.id), [good.id]);
  assert.equal((await json<ComicVideoHistory>("/videos?adopted=false&seriesId=" + ep.detail.series.id)).entries.length, 0);
  const foreign = await request("/videos?seriesId=" + ep.detail.series.id, "GET", undefined, "fixture-two");
  assert.deepEqual(await foreign.json(), { entries: [], nextCursor: null });
  const links = await json<{ url: string }>(`/media/${good.mediaId}/links`);
  const range = await app.request(links.url, { headers: { Range: "bytes=0-23" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("Content-Type"), "video/mp4");
  assert.equal((await range.arrayBuffer()).byteLength, 24);

  const savedFrame = await json<{ id: string }>(`/video-takes/${good.id}/frame`, "POST", {
    timeMs: 1250, destination: { kind: "material", material: { kind: "scene", name: "W6 extracted frame", categoryKey: null, tags: [] } },
  }, 201);
  const versions = await json<{ media: { id: string; mime: string } }[]>(`/materials/${savedFrame.id}/versions`);
  assert.equal(versions[0].media.mime, "image/png");
  const { id: characterId } = await json<{ id: string }>("/characters", "POST",
    { name: "W6 frame role", tags: [], aliases: [], roleKey: "lead", age: "", appearance: "", personality: "" }, 201);
  const destination = { kind: "character", characterId, target: { kind: "expression", key: "smile" } };
  await json(`/video-takes/${good.id}/frame`, "POST", { timeMs: 4000, destination }, 400);
  const face = await json<{ version: number }>(`/video-takes/${good.id}/frame`, "POST", { timeMs: 1200, destination }, 201);
  assert.equal(face.version, 1);

  state.disconnect = true;
  state.badDownload = true;
  const next = await confirm(ep, await preview(ep, [interrupted]));
  const interruptedTake = (await settled(next.id)).takes[0];
  const original = await receipt(interruptedTake.id);
  assert.equal(interruptedTake.state, "recoverable");
  assert.equal(original.state, "accepted");
  await until(() => queue.canResumePersisted(next.taskId));
  await pool.query("UPDATE tasks SET status='running',updated_at=now()-interval '4 minutes' WHERE id=$1", [next.taskId]);
  await new PgComicGeneration(pool).reconcileInterrupted(id => queue.canResumePersisted(id));
  assert.equal((await read(next.id)).active, false);
  assert.equal((await resume(next, interruptedTake.id)).takes[0].state, "recoverable");
  assert.equal((await receipt(interruptedTake.id)).state, "output");
  state.expireDownload = true;
  assert.equal((await resume(next, interruptedTake.id)).takes[0].state, "ready");
  assert.equal(submitted.filter(call => call.scene === "W6 interrupted").length, 1);
  assert.equal(polls.filter(vendor => vendor === original.vendorId).length, 3);
  assert.equal(new Set(downloads.filter(url => url.includes(String(original.vendorId)))).size, 2);

  const kling = await makeEpisode("W6 Kling fixture", w6Kling, ["W6 cancel after submit", "W6 cancel before submit"]);
  const frame = (await settled((await confirm(kling, await preview(kling, [kling.detail.clips[0]], "keyframe"))).id)).takes[0];
  await json(kling.path + `/clips/${kling.detail.clips[0].id}/keyframe/confirm`, "POST",
    { keyframeTakeId: frame.id, expectedClipRevision: kling.detail.clips[0].revision,
      expectedSelectionRevision: kling.detail.clips[0].selectionRevision ?? 1 });
  const references = { visualReferences: [{ materialId: savedFrame.id, mediaId: versions[0].media.id, kind: "scene" }] };
  const withRefs = await preview(kling, undefined, "from_keyframe", references);
  assert.deepEqual(withRefs.items[0].referenceVersions?.map(item => item.mediaId), [frame.mediaId, versions[0].media.id]);
  assert.equal(withRefs.skipped[0].reason, "KEYFRAME_NOT_CONFIRMED");
  const sibling = kling.detail.clips[1];
  const siblingFrame = (await settled((await confirm(kling, await preview(kling, [sibling], "keyframe"))).id)).takes[0];
  await json(kling.path + `/clips/${sibling.id}/keyframe/confirm`, "POST",
    { keyframeTakeId: siblingFrame.id, expectedClipRevision: sibling.revision, expectedSelectionRevision: sibling.selectionRevision ?? 1 });
  const staleRefQuote = await preview(kling, [kling.detail.clips[0]], "from_keyframe", references);
  const replaceMaterial = await app.request(COMIC_DRAMA_API_ROOT + `/materials/${savedFrame.id}/files`, {
    method: "POST",
    headers: { Authorization: "Bearer fixture-one", "Content-Type": "image/png" },
    body: new Uint8Array(await comicFixturePng("#405060")),
  });
  assert.equal(replaceMaterial.status, 201);
  assert.equal((await json<{ code: string }>(kling.path + "/generate", "POST", { confirmationId: staleRefQuote.confirmationId }, 409)).code, "QUOTE_STALE");
  const latestVersions = await json<{ media: { id: string } }[]>(`/materials/${savedFrame.id}/versions`);
  const freshReferences = { visualReferences: [{ materialId: savedFrame.id, mediaId: latestVersions[0].media.id, kind: "scene" }] };
  const run = await confirm(kling, await preview(kling, undefined, "from_keyframe", freshReferences));
  await until(() => state.waiting);
  const stopped = await confirm(ep, await preview(ep, [rejected]));
  await json(`/video-takes/${run.takes[1].id}/cancel`, "POST", {});
  await json(`/video-takes/${stopped.takes[0].id}/cancel`, "POST", {});
  await json(`/video-takes/${run.takes[0].id}/cancel`, "POST", {});
  assert.deepEqual((await settled(run.id)).takes.map(take => take.state), ["recoverable", "cancelled"]);
  assert.equal((await settled(stopped.id)).takes[0].state, "cancelled");
  const klingCall = submitted.find(call => call.model === w6Kling)!;
  assert.ok(klingCall.request.first_frame);
  assert.equal((klingCall.request.input_reference as string[]).length, 1);
  state.releasePoll = true;
  assert.deepEqual((await resume(run, run.takes[0].id)).takes.map(take => take.state), ["ready", "cancelled"]);
  assert.equal(submitted.filter(call => call.model === w6Kling).length, 1);
  assert.equal(submitted.filter(call => call.scene === "W6 reject").length, 1);
  console.log("PASS W6 PG/Redis/HTTP: both video contracts, mixed batch, checkpoints, release, targeted cancel/resume, adoption, Range, frame saves");
  return ep.detail.series.id;
}
