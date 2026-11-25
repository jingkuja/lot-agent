import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { OpenaiVideoAdapter, ProviderError, type VideoGenerationProvider } from "@lot-agent/core";
import {
  COMIC_DRAMA_API_ROOT, type ComicDramaClip, type ComicDramaContent, type ComicDramaDetail, type ComicGenerationMode,
  type ComicGenerationQuote, type ComicGenerationRequest, type ComicVideoHistory, type ComicVideoReceipt, type ComicVideoTake,
  type ComicEpisodeBudget, type ComicVideoCreditPause,
} from "@lot-agent/core/comic-drama";
import type { ComicMediaLibrary } from "../../src/comic-drama/media-library.js";
import { runComicVideoGeneration } from "../../src/comic-drama/video-worker.js";
import { PgComicGeneration } from "../../src/comic-drama/generation-repository.js";
import { queryComicDramaReport } from "../../src/comic-drama/operations-report.js";
import type { BullmqJobQueue } from "../../src/jobs/bullmq-queue.js";
import { COMIC_VIDEO_QUEUE, COMIC_VIDEO_TASK } from "../../src/jobs/task-queues.js";
import { ffmpeg, mediaProcess } from "../../src/marketing-video/media.js";
import { comicFixturePng } from "./check-comic-drama-library.js";

export const w6Seedance20 = "doubao-seedance-2-0";
export const w6Seedance25 = "doubao-seedance-2-5";

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
  const state = { disconnect: false, badDownload: false, expireDownload: false, waiting: false, releasePoll: false, quoteExtra: 0 };
  const creditBalances = new Map<string, number | null>();
  const gatewayCreditBlocks = new Set<string>();
  const provider: VideoGenerationProvider = {
    async create(req) {
      const model = req.model ?? "";
      assert.ok([w6Seedance20, w6Seedance25].includes(model));
      const request = new OpenaiVideoAdapter().buildCreateBody(req, model) as Record<string, unknown>;
      const scene = /^Scene: (.+)\.$/m.exec(req.prompt)?.[1] ?? "";
      submitted.push({ model, scene, request });
      for (const ref of [req.first_frame, req.last_frame, ...[req.input_reference, req.reference_audio, req.reference_video].flat()].filter(Boolean)) {
        const url = new URL(String(ref));
        assert.equal(url.origin, "https://comic-fixture.invalid");
        assert.match(url.pathname, /^\/api\/public\/comic-drama-media\//);
        assert.ok(url.searchParams.get("material_token"));
      }
      assert.equal(request.seconds, "4");
      const adaptive = model === w6Seedance25 && !!req.first_frame;
      assert.equal(request.ratio, adaptive ? "adaptive" : "9:16");
      assert.equal(request.size, adaptive ? undefined : "720x1280");
      assert.deepEqual(request.metadata, { resolution: "720p" });
      assert.equal(request.generate_audio, !!req.reference_audio);
      if (gatewayCreditBlocks.has(scene)) {
        throw new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 403, vendorCode: "insufficient_user_quota" });
      }
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
    checkCredits: async (user, input) => {
      assert.equal(user, owner);
      const match = /^Scene: (.+)\.$/m.exec(input.prompt)?.[1] ?? "";
      const availablePoints = creditBalances.get(match);
      return availablePoints === null ? { reason: "unavailable" }
        : availablePoints !== undefined && availablePoints < 100 ? { reason: "insufficient", availablePoints, requiredPoints: 100 } : null;
    },
    download: async (url, _options, consume) => {
      downloads.push(url);
      if (state.badDownload) { state.badDownload = false; throw new Error("fixture download interrupted"); }
      if (state.expireDownload) { state.expireDownload = false; throw Object.assign(new Error("fixture output expired"), { status: 403 }); }
      return consume({ body: new Response(new Uint8Array(body)).body, mime: "video/mp4" });
    },
  }, job, control.signal));
  return { submitted, polls, downloads, state, queue, creditBalances, gatewayCreditBlocks, root };
}

type FixtureApp = Hono<{ Variables: { userId: string } }>;
type Fixture = Awaited<ReturnType<typeof mountComicVideoFixture>>;

export async function verifyComicVideo(app: FixtureApp, pool: Pool, fixture: Fixture, advanceClock: (ms: number) => void) {
  const { submitted, polls, downloads, state, queue, creditBalances, gatewayCreditBlocks } = fixture;
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
  async function makeEpisode(title: string, model: string, scenes: string[], durationMs = 4000) {
    let detail = await json<ComicDramaDetail>("/series", "POST", { title, styleKey: "webtoon", aspectRatio: "9:16", videoModel: model }, 201);
    const path = "/series/" + detail.series.id;
    for (const scene of scenes) {
      const added = await json<ComicDramaContent>(path + "/clips", "POST", { expectedRevision: detail.series.revision }, 201);
      const clip = added.clips.at(-1)!;
      await json(path + "/clips/" + clip.id, "PATCH", { expectedRevision: clip.revision, draft: { ...clip.draft, scene, durationMs,
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

  const ep = await makeEpisode("W6 video fixture", w6Seedance20, ["W6 ready", "W6 reject", "W6 unknown", "W6 interrupted"]);
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
  assert.equal(mixedQuote.videoTokenEstimate, true);
  state.quoteExtra = 1;
  try {
    const changed = await json<{ code: string }>(ep.path + "/generate", "POST", { confirmationId: mixedQuote.confirmationId }, 409);
    assert.equal(changed.code, "PRICE_CHANGED");
    assert.equal(submitted.length, 0, "A changed gateway quote must not submit media");
  } finally { state.quoteExtra = 0; }
  const [created, duplicate] = await Promise.all([confirm(ep, mixedQuote), confirm(ep, mixedQuote)]);
  assert.equal(created.taskId, duplicate.taskId);
  assert.equal((await pool.query("SELECT queue_name FROM tasks WHERE id=$1", [created.taskId])).rows[0].queue_name, COMIC_VIDEO_QUEUE);
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

  const seedance = await makeEpisode("W6 Seedance 2.5 fixture", w6Seedance25, ["W6 cancel after submit", "W6 cancel before submit"]);
  const frame = (await settled((await confirm(seedance, await preview(seedance, [seedance.detail.clips[0]], "keyframe"))).id)).takes[0];
  await json(seedance.path + `/clips/${seedance.detail.clips[0].id}/keyframe/confirm`, "POST",
    { keyframeTakeId: frame.id, expectedClipRevision: seedance.detail.clips[0].revision,
      expectedSelectionRevision: seedance.detail.clips[0].selectionRevision ?? 1 });
  const references = { visualReferences: [{ materialId: savedFrame.id, mediaId: versions[0].media.id, kind: "scene" }] };
  const withRefs = await preview(seedance, undefined, "from_keyframe", references);
  assert.equal(withRefs.items.length, 0);
  assert.deepEqual(withRefs.skipped.map(item => item.reason), ["REFERENCE_MODE_CONFLICT", "REFERENCE_MODE_CONFLICT"]);
  const sibling = seedance.detail.clips[1];
  const siblingFrame = (await settled((await confirm(seedance, await preview(seedance, [sibling], "keyframe"))).id)).takes[0];
  await json(seedance.path + `/clips/${sibling.id}/keyframe/confirm`, "POST",
    { keyframeTakeId: siblingFrame.id, expectedClipRevision: sibling.revision, expectedSelectionRevision: sibling.selectionRevision ?? 1 });
  const staleRefQuote = await preview(seedance, [seedance.detail.clips[0]], "references", references);
  const replaceMaterial = await app.request(COMIC_DRAMA_API_ROOT + `/materials/${savedFrame.id}/files`, {
    method: "POST",
    headers: { Authorization: "Bearer fixture-one", "Content-Type": "image/png" },
    body: new Uint8Array(await comicFixturePng("#405060")),
  });
  assert.equal(replaceMaterial.status, 201);
  assert.equal((await json<{ code: string }>(seedance.path + "/generate", "POST", { confirmationId: staleRefQuote.confirmationId }, 409)).code, "QUOTE_STALE");
  const latestVersions = await json<{ media: { id: string } }[]>(`/materials/${savedFrame.id}/versions`);
  const freshReferences = { visualReferences: [{ materialId: savedFrame.id, mediaId: latestVersions[0].media.id, kind: "scene" }] };
  const run = await confirm(seedance, await preview(seedance, undefined, "references", freshReferences));
  await until(() => state.waiting);
  const stopped = await confirm(ep, await preview(ep, [rejected]));
  await json(`/video-takes/${run.takes[1].id}/cancel`, "POST", {});
  await json(`/video-takes/${stopped.takes[0].id}/cancel`, "POST", {});
  await json(`/video-takes/${run.takes[0].id}/cancel`, "POST", {});
  assert.deepEqual((await settled(run.id)).takes.map(take => take.state), ["recoverable", "cancelled"]);
  assert.equal((await settled(stopped.id)).takes[0].state, "cancelled");
  const seedanceCall = submitted.find(call => call.model === w6Seedance25)!;
  assert.equal(seedanceCall.request.first_frame, undefined);
  assert.equal((seedanceCall.request.input_reference as string[]).length, 1);
  state.releasePoll = true;
  assert.deepEqual((await resume(run, run.takes[0].id)).takes.map(take => take.state), ["ready", "cancelled"]);
  assert.equal(submitted.filter(call => call.model === w6Seedance25).length, 1);
  assert.equal(submitted.filter(call => call.scene === "W6 reject").length, 1);
  console.log("PASS W6 PG/Redis/HTTP: both video contracts, mixed batch, checkpoints, release, targeted cancel/resume, adoption, Range, frame saves");

  const budgetEpisode = await makeEpisode("Budget preview", w6Seedance20, ["Eight seconds A", "Eight seconds B"], 8000);
  const budgetEstimate = (revision: number, speechLines: number) => json<ComicEpisodeBudget>(budgetEpisode.path + "/episode-budget", "POST", {
    expectedRevision: revision, videoMode: "from_keyframe", materialImages: 1, speechLines,
  });
  const [firstBudgetClip, secondBudgetClip] = budgetEpisode.detail.clips;
  const budgetFrames = await confirm(budgetEpisode, await preview(budgetEpisode, undefined, "keyframe"));
  assert.deepEqual((await settled(budgetFrames.id)).takes.map(item => item.state), ["ready", "ready"]);
  const noNewSpeech = await budgetEstimate(budgetEpisode.detail.series.revision, 0);
  assert.deepEqual(noNewSpeech.items.map(item => [item.kind, item.quantity, item.estimatedPoints]), [
    ["video", 8, 200], ["video", 8, 200], ["material", 1, 20],
  ]);
  assert.equal(noNewSpeech.knownPoints, 420);
  assert.ok(noNewSpeech.estimatedMonetaryTotals?.length);
  const withSpeech = await budgetEstimate(budgetEpisode.detail.series.revision, 3);
  assert.deepEqual(withSpeech.items.map(item => item.kind), ["video", "video", "material", "speech"]);
  assert.equal(withSpeech.knownPoints, 720);
  assert.equal(withSpeech.unverifiedCount, 0);
  const changedDuration = await json<{ seriesRevision: number }>(budgetEpisode.path + "/clips/" + secondBudgetClip.id, "PATCH", {
    expectedRevision: secondBudgetClip.revision, draft: { ...secondBudgetClip.draft, durationMs: 10000 },
  });
  const changedBudget = await budgetEstimate(changedDuration.seriesRevision, 3);
  assert.deepEqual(changedBudget.items.filter(item => item.clipId).map(item => [item.clipId, item.kind, item.quantity, item.estimatedPoints]), [
    [secondBudgetClip.id, "keyframe", 1, 20], [firstBudgetClip.id, "video", 8, 200], [secondBudgetClip.id, "video", 10, 250],
  ]);
  assert.equal(changedBudget.knownPoints, 790);
  console.log("PASS episode budget: reusable and stale first frames, per-clip video duration, shared asset, and controlled speech credits");

  const scenes = ["Credits covered", "Credits low", "Credits check unavailable", "Credits need topup"];
  const creditEp = await makeEpisode("Credit validation", w6Seedance20, scenes);
  const startCount = submitted.length;
  const budgetInput = { expectedRevision: creditEp.detail.series.revision, videoMode: "references", materialImages: 1 };
  const budget = await json<ComicEpisodeBudget>(creditEp.path + "/episode-budget", "POST", budgetInput);
  assert.equal(budget.knownPoints, 420);
  assert.deepEqual(budget.items.map(item => item.kind), ["video", "video", "video", "video", "material"]);
  assert.equal((await request(creditEp.path + "/episode-budget", "POST", budgetInput, "fixture-two")).status, 404);
  assert.equal(submitted.length, startCount, "Budgeting does not submit videos");

  creditBalances.set("Credits covered", 100);
  creditBalances.set("Credits low", 80);
  creditBalances.set("Credits check unavailable", null);
  creditBalances.set("Credits need topup", 80);
  const creditRun = await confirm(creditEp, await preview(creditEp));
  const [, lowTake, unavailableTake, rechargeTake] = (await settled(creditRun.id)).takes;
  const pausesPath = creditEp.path + "/video-credit-pauses";
  const readPauses = () => json<ComicVideoCreditPause[]>(pausesPath);
  const resumeCredits = async (id: string, override = false) => {
    await until(() => queue.canResumePersisted(creditRun.taskId));
    await json(`/video-takes/${id}/resume-credits`, "POST", override ? { continueDespiteLowCredits: true } : {}, 202);
    return settled(creditRun.id);
  };
  assert.deepEqual((await readPauses())[0].check, { reason: "insufficient", availablePoints: 80, requiredPoints: 100 });
  assert.equal((await json<ComicDramaDetail>(creditEp.path)).summary?.costs?.pendingReconcileCount, 0);
  assert.equal((await receipt(lowTake.id)).state, "unsubmitted");
  assert.equal((await receipt(unavailableTake.id)).state, "unsubmitted");
  assert.deepEqual(await (await request(pausesPath, "GET", undefined, "fixture-two")).json(), []);
  await until(() => queue.canResumePersisted(creditRun.taskId));
  assert.equal((await request(`/video-takes/${lowTake.id}/resume-credits`, "POST", {}, "fixture-two")).status, 404);
  assert.equal((await request(`/video-takes/${unavailableTake.id}/recover`, "POST", {})).status, 409);
  await resumeCredits(lowTake.id);
  assert.equal(submitted.length, startCount + 1, "A recheck with unchanged balance still pauses without another submission");
  creditBalances.set("Credits low", null);
  await resumeCredits(lowTake.id, true);
  assert.equal(submitted.length, startCount + 1, "An override does not bypass a failed price or balance lookup");
  creditBalances.set("Credits low", 80);
  await resumeCredits(lowTake.id);
  await resumeCredits(lowTake.id, true);
  assert.deepEqual((await readPauses())[0].check, { reason: "unavailable" });
  await until(() => queue.canResumePersisted(creditRun.taskId));
  assert.equal((await request(`/video-takes/${unavailableTake.id}/resume-credits`, "POST", { continueDespiteLowCredits: true })).status, 409);
  creditBalances.set("Credits check unavailable", 150);
  await resumeCredits(unavailableTake.id);
  assert.equal((await readPauses())[0].takeId, rechargeTake.id, "Continuing a take does not bypass credit checks on later takes");
  assert.equal((await receipt(rechargeTake.id)).state, "unsubmitted");
  creditBalances.set("Credits need topup", 100);
  await until(() => queue.canResumePersisted(creditRun.taskId));
  const responses = await Promise.all([1, 2].map(() => request(`/video-takes/${rechargeTake.id}/resume-credits`, "POST", {})));
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  assert.deepEqual((await settled(creditRun.id)).takes.map(take => take.state), ["ready", "ready", "ready", "ready"]);
  assert.deepEqual(await readPauses(), []);
  assert.deepEqual(submitted.slice(startCount).map(call => call.scene), scenes);
  const remaining = await json<ComicEpisodeBudget>(creditEp.path + "/episode-budget", "POST", budgetInput);
  assert.deepEqual(remaining.items.map(item => item.kind), ["material"]);
  console.log("PASS episode budget and credit pauses: account scope, no double submit, repeat checks, recharge, single-take override");

  const recoveryScenes = ["W6 interrupted", "Credits output saved", "Credits gateway rejected", "Credits queued behind rejection"];
  const recoveryEp = await makeEpisode("Video receipt recovery during a credit pause", w6Seedance20, recoveryScenes);
  const initialCalls = submitted.length;
  state.disconnect = true;
  state.badDownload = true;
  gatewayCreditBlocks.add(recoveryScenes[2]);
  const recoveryRun = await confirm(recoveryEp, await preview(recoveryEp));
  const [acceptedTake, outputTake, pausedTake, queuedTake] = (await settled(recoveryRun.id)).takes;
  assert.equal((await receipt(acceptedTake.id)).state, "accepted");
  assert.equal((await receipt(outputTake.id)).state, "output");
  assert.equal((await receipt(pausedTake.id)).state, "unsubmitted");
  assert.deepEqual(pausedTake.creditCheck, { reason: "gateway-insufficient" });
  assert.equal(queuedTake.canRecover, false);
  assert.deepEqual(submitted.slice(initialCalls).map(call => call.scene), recoveryScenes.slice(0, 3));

  assert.deepEqual((await resume(recoveryRun, acceptedTake.id)).takes.map(take => take.state), ["ready", "recoverable", "recoverable", "recoverable"]);
  assert.equal((await resume(recoveryRun, outputTake.id)).takes[1].state, "ready");
  assert.equal(submitted.length, initialCalls + 3, "Recovering receipts does not submit any new request");
  assert.deepEqual((await json<ComicVideoCreditPause[]>(recoveryEp.path + "/video-credit-pauses"))[0].check, { reason: "gateway-insufficient" });
  await until(() => queue.canResumePersisted(recoveryRun.taskId));
  await json(`/video-takes/${pausedTake.id}/resume-credits`, "POST", { continueDespiteLowCredits: true }, 409);
  gatewayCreditBlocks.delete(recoveryScenes[2]);
  await json(`/video-takes/${pausedTake.id}/resume-credits`, "POST", {}, 202);
  assert.deepEqual((await settled(recoveryRun.id)).takes.map(take => take.state), ["ready", "ready", "ready", "ready"]);
  assert.deepEqual(submitted.slice(initialCalls + 3).map(call => call.scene), recoveryScenes.slice(2));
  assert.equal((await receipt(pausedTake.id)).httpStatus, null);
  console.log("PASS credit pause recovery: accepted and output receipts recover independently, gateway rejection stays paused until explicit recheck");
  const referenceEp = await makeEpisode("Multimodal reference validation", w6Seedance25, ["Verified references", "Excess output duration"]);
  const soundPath = join(fixture.root, "reference.wav");
  const movementPath = join(fixture.root, "reference.mov");
  await Promise.all([
    mediaProcess(ffmpeg(), ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=4",
      "-c:a", "pcm_s16le", soundPath], { timeoutMs: 15_000 }),
    mediaProcess(ffmpeg(), ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=720x720:r=24:d=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", movementPath], { timeoutMs: 15_000 }),
  ]);
  const uploadReference = async (path: string, kind: "audio" | "video", mime: string) => {
    const response = await app.request(COMIC_DRAMA_API_ROOT + `/materials/upload?kind=other&name=${kind}`, {
      method: "POST", body: new Uint8Array(await readFile(path)),
      headers: { Authorization: "Bearer fixture-one", "Content-Type": mime },
    });
    const result = await response.json() as { id: string; mediaId: string };
    assert.equal(response.status, 201, JSON.stringify(result));
    return { kind, materialId: result.id, mediaId: result.mediaId };
  };
  const audio = await uploadReference(soundPath, "audio", "audio/wav");
  const motion = await uploadReference(movementPath, "video", "video/quicktime");
  const videoMaterials = await json<{ entries: { id: string }[] }>("/materials?mime=video");
  assert.deepEqual(videoMaterials.entries.map(material => material.id), [motion.materialId]);
  for (const [index, clip] of referenceEp.detail.clips.entries()) {
    await json(referenceEp.path + "/clips/" + clip.id, "PATCH", {
      expectedRevision: clip.revision,
      draft: {
        ...clip.draft, durationMs: index === 0 ? 4000 : 31_000, videoInputs: { references: [audio, motion] },
        shots: [{ ...clip.draft.shots[0], description: "Match @Audio1 with the movement in @Video1." }],
      },
    });
  }
  referenceEp.detail = await json<ComicDramaDetail>(referenceEp.path);
  const quote = await preview(referenceEp);
  const [validClip, invalidClip] = referenceEp.detail.clips;
  assert.deepEqual(quote.items.map(item => item.clipId), [validClip.id]);
  assert.deepEqual(quote.items[0].referenceVersions, [
    { kind: "audio", mediaId: audio.mediaId, version: 1 }, { kind: "video", mediaId: motion.mediaId, version: 1 },
  ]);
  assert.deepEqual(quote.skipped[0].issues, [{ code: "DURATION_UNSUPPORTED", field: "outputSeconds", actual: 31, min: 4, max: 30 }]);
  assert.equal(quote.skipped[0].clipId, invalidClip.id);
  const brokenAudio = join(fixture.root, audio.mediaId + ".wav");
  const previousCalls = submitted.length;
  await rename(brokenAudio, brokenAudio + ".bak");
  try {
    assert.equal((await json<{ code: string }>(referenceEp.path + "/generate", "POST", { confirmationId: quote.confirmationId }, 409)).code,
      "QUOTE_STALE");
    const mediaMissing = await preview(referenceEp, [validClip]);
    assert.equal(mediaMissing.skipped[0].reason, "REFERENCE_UNVERIFIED");
    assert.equal(submitted.length, previousCalls);
  } finally {
    await rename(brokenAudio + ".bak", brokenAudio);
  }
  const multimodal = await settled((await confirm(referenceEp, await preview(referenceEp))).id);
  assert.deepEqual(multimodal.takes.map(take => take.state), ["ready"]);
  const requestBody = submitted.at(-1)!.request;
  assert.equal(requestBody.omni_reference_task_type, "reference");
  assert.match((requestBody.reference_audio as string[])[0], /\.wav\?/);
  assert.match((requestBody.reference_video as string[])[0], /\.mov\?/);
  assert.equal(requestBody.generate_audio, true);
  const signedMov = new URL((requestBody.reference_video as string[])[0]);
  assert.equal((await app.request(signedMov.pathname, { headers: { Authorization: "Bearer fixture-two" } })).status, 404);
  const fetchMov = () => app.request(signedMov, { headers: { Range: "bytes=0-31" } });
  const firstRead = await fetchMov();
  assert.equal(firstRead.status, 206);
  assert.equal(firstRead.headers.get("content-type"), "video/quicktime");
  assert.deepEqual(Buffer.from(await firstRead.arrayBuffer()), (await readFile(movementPath)).subarray(0, 32));
  advanceClock(59 * 60_000);
  try {
    assert.equal((await fetchMov()).status, 206);
    advanceClock(60_000);
    try { assert.equal((await fetchMov()).status, 404); } finally { advanceClock(-60_000); }
  } finally { advanceClock(-59 * 60_000); }
  console.log("PASS signed MOV: scoped private access, 60-minute expiry and provider Range request");
  console.log("PASS per-clip references: actual WAV and MOV metadata, partial batch, fresh verification, and frozen gateway inputs");
  return { episode: ep.detail.series.id, referenceEpisode: referenceEp.detail.series.id };
}
