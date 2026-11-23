import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Hono } from "hono";
import Redis from "ioredis";
import type { Pool } from "pg";
import type { ImageGenerationProvider } from "@lot-agent/core";
import {
  COMIC_DRAMA_API_ROOT, type ComicCharacterDetail, type ComicDramaClip, type ComicDramaContent, type ComicDramaDetail,
  type ComicGenerationQuote, type ComicImageRequest, type ComicKeyframeHistory,
} from "@lot-agent/core/comic-drama";
import { createComicGenerationRoutes } from "../../src/comic-drama/generation-routes.js";
import { PgComicGeneration } from "../../src/comic-drama/generation-repository.js";
import { runComicImageGeneration } from "../../src/comic-drama/generation-worker.js";
import type { PgComicLibrary } from "../../src/comic-drama/library-repository.js";
import type { ComicMediaLibrary } from "../../src/comic-drama/media-library.js";
import type { PgComicDramaRepository } from "../../src/comic-drama/repository.js";
import { DB } from "../../src/db/database.js";
import { BullmqJobQueue } from "../../src/jobs/bullmq-queue.js";
import { COMIC_IMAGE_TASK, MARKETING_VIDEO_QUEUE } from "../../src/jobs/task-queues.js";
import { comicFixturePng } from "./check-comic-drama-library.js";
import { mountComicVideoFixture, w6Grok, w6Kling } from "./check-comic-drama-video.js";

type FixtureApp = Hono<{ Variables: { userId: string } }>;

export async function mountComicGenerationFixture(deps: {
  app: FixtureApp; database: URL; redisUrl: string; pool: Pool; series: PgComicDramaRepository; library: PgComicLibrary;
  media: ComicMediaLibrary; receiptPath: string; mediaRoot: string; owner: string;
  accepting?: () => void;
}) {
  const redis = new URL(deps.redisUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(redis.hostname) && redis.port && redis.port !== "6379",
    "Use a disposable loopback Redis on an isolated port");
  const db = new DB({ host: deps.database.hostname, port: Number(deps.database.port), user: deps.database.username,
    password: decodeURIComponent(deps.database.password), database: deps.database.pathname.slice(1) });
  const connection = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });
  const queue = new BullmqJobQueue(db, connection);
  const video = await mountComicVideoFixture({ ...deps, queue, root: deps.mediaRoot });
  const png = await comicFixturePng();
  const counts = { submits: 0, polls: 0, downloads: 0, publications: 0, references: 0 };
  const state = { price: 40_000, failDelivery: false, failPoll: false, failDownload: false, next: "inline" as "inline" | "async" | "unknown" };
  const provider: ImageGenerationProvider = {
    async create(input) {
      assert.equal(input.model, "fixture-image");
      assert.equal(input.n, 1);
      assert.ok(input.prompt.length > 20);
      for (const reference of input.media ?? []) assert.match(reference.url, /^data:image\/jpeg;base64,/);
      counts.references += input.media?.length ?? 0;
      counts.submits++;
      const mode = state.next;
      state.next = "inline";
      if (mode === "unknown") throw Object.assign(new Error("response lost"), { gatewayRequestId: "fixture-unknown" });
      const receipt = { taskId: "fixture-task-" + counts.submits, progress: 0, gatewayRequestId: "fixture-call-" + counts.submits };
      if (mode === "async") return { ...receipt, status: "submitted" };
      return { ...receipt, status: "completed",
        result: { status: "completed", progress: 100, url: "data:image/png;base64," + png.toString("base64") } };
    },
    async poll(taskId) {
      assert.match(taskId, /^fixture-task-\d+$/);
      counts.polls++;
      if (state.failPoll) { state.failPoll = false; throw new Error("fixture poll disconnect"); }
      return { status: "completed", progress: 100, url: "https://fixture.invalid/generated.png" };
    },
  };
  queue.process(COMIC_IMAGE_TASK, (job, control) => runComicImageGeneration({
    pool: deps.pool, receiptPath: deps.receiptPath, media: deps.media, pollIntervalMs: 5,
    provider: async user => { assert.equal(user, deps.owner); return provider; },
    download: async url => {
      counts.downloads++;
      assert.equal(url, "https://fixture.invalid/generated.png");
      if (state.failDownload) { state.failDownload = false; throw new Error("fixture CDN disconnect"); }
      return { body: png, mime: "image/png" };
    },
  }, job, control.signal));
  deps.app.route(COMIC_DRAMA_API_ROOT, createComicGenerationRoutes({
    ...deps,
    quotePrice: async owner => owner === deps.owner ? { modelId: "fixture-image", amountMicros: state.price } : null,
    quoteVideoPrice: async (owner, modelId) => owner === deps.owner && [w6Grok, w6Kling].includes(modelId) ?
      { modelId, amountMicros: 500_000, unit: "second" } : null,
    queue: {
      publishNewTask: async (id, type) => {
        counts.publications++;
        if (state.failDelivery) { state.failDelivery = false; throw new Error("fixture delivery disconnect"); }
        await queue.publishNewTask(id, type);
      },
      resumePersisted: (id, type) => queue.resumePersisted(id, type),
      canResumePersisted: id => queue.canResumePersisted(id),
    },
  }));
  return { counts, state, queue, video, close: async () => { await queue.close(); connection.disconnect(); await db.close(); } };
}

type Fixture = Awaited<ReturnType<typeof mountComicGenerationFixture>>;

export async function verifyComicGeneration(app: FixtureApp, pool: Pool, fixture: Fixture) {
  const { counts, state, queue } = fixture;
  const request = (path: string, method = "GET", data?: unknown, token = "fixture-one") => app.request(COMIC_DRAMA_API_ROOT + path, {
    method, body: data === undefined ? undefined : JSON.stringify(data),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  async function json<T>(path: string, method = "GET", data?: unknown, expected = 200): Promise<T> {
    const result = await request(path, method, data);
    const body = await result.json();
    assert.equal(result.status, expected, `${method} ${path} ${JSON.stringify(body)}`);
    return body as T;
  }
  async function settled(id: string) {
    for (let i = 0; i < 200; i++) {
      const result = await json<ComicImageRequest>("/generation-requests/" + id);
      if (!result.active) return result;
      await delay(25);
    }
    throw new Error("Fixture generation did not settle");
  }
  async function recover(run: ComicImageRequest) {
    for (let i = 0; i < 100 && !await queue.canResumePersisted(run.taskId); i++) await delay(25);
    return json<ComicImageRequest>(`/generation-requests/${run.id}/recover`, "POST", {}, 202);
  }

  const { series } = await json<ComicDramaDetail>("/series", "POST",
    { title: "W5 fixture", styleKey: "webtoon", aspectRatio: "9:16", videoModel: null }, 201);
  const scope = "/series/" + series.id;
  const one = await json<ComicDramaContent>(scope + "/clips", "POST", { expectedRevision: series.revision }, 201);
  const two = await json<ComicDramaContent>(scope + "/clips", "POST", { expectedRevision: one.seriesRevision }, 201);
  const [first, blank] = two.clips;
  const firstPath = `${scope}/clips/${first.id}`;
  const save = (clip: ComicDramaClip) => json<{ clip: ComicDramaClip; seriesRevision: number }>(firstPath, "PATCH", {
    expectedRevision: clip.revision, draft: { ...clip.draft, shots: [{
      id: "da857770-e298-4534-b90d-4065e44b9513", framingKey: "medium", movementKey: "fixed", description: "Original shot", durationShare: 100,
    }] },
  });
  let saved = await save(first);
  const preview = () => json<ComicGenerationQuote>(scope + "/generation-preview", "POST", {
    mode: "keyframe", expectedSeriesRevision: saved.seriesRevision,
    targets: [{ clipId: first.id, expectedRevision: saved.clip.revision }, { clipId: blank.id, expectedRevision: blank.revision }],
  });
  const confirm = (quote: ComicGenerationQuote, expected = 202) =>
    json<ComicImageRequest>(scope + "/generate", "POST", { confirmationId: quote.confirmationId }, expected);
  const initial = await preview();
  assert.equal(initial.totalMicros, 40_000);
  assert.deepEqual(initial.skipped, [{ clipId: blank.id, reason: "NO_SHOTS" }]);
  assert.equal((await pool.query("SELECT 1 FROM tasks WHERE type=$1", [COMIC_IMAGE_TASK])).rowCount, 0);
  assert.equal(counts.submits, 0);
  assert.equal(counts.publications, 0);
  assert.equal((await request(scope + "/generate", "POST", { confirmationId: initial.confirmationId }, "fixture-two")).status, 404);

  const expired = await preview();
  await pool.query("UPDATE lot_comic_drama.cd_generation_requests SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.confirmationId]);
  assert.equal((await confirm(expired, 409) as unknown as { code: string }).code, "QUOTE_EXPIRED");
  saved = await save(saved.clip);
  assert.equal((await confirm(initial, 409) as unknown as { code: string }).code, "QUOTE_STALE");
  const repriced = await preview();
  state.price++;
  assert.equal((await confirm(repriced, 409) as unknown as { code: string }).code, "PRICE_CHANGED");
  state.price--;

  const payable = await preview(), competing = await preview();
  state.next = "async";
  state.failPoll = true;
  state.failDownload = true;
  const [result, duplicate] = await Promise.all([confirm(payable), confirm(payable)]);
  assert.equal(duplicate.taskId, result.taskId);
  assert.equal(duplicate.takes[0].id, result.takes[0].id);
  assert.equal(counts.publications, 1);
  assert.equal((await confirm(competing, 409) as unknown as { code: string }).code, "BUSY");
  assert.equal((await pool.query("SELECT queue_name FROM tasks WHERE id=$1", [result.taskId])).rows[0].queue_name, MARKETING_VIDEO_QUEUE);
  assert.equal((await request("/generation-requests/" + result.id, "GET", undefined, "fixture-two")).status, 404);
  let completed = await settled(result.id);
  assert.equal(completed.takes[0].state, "recoverable");
  assert.equal(counts.submits, 1);
  const receipt = (await pool.query("SELECT state,vendor_id,gateway_request_id FROM image_call_receipts WHERE task_id=$1", [result.taskId])).rows[0];
  assert.deepEqual(receipt, { state: "submitted", vendor_id: "fixture-task-1", gateway_request_id: "fixture-call-1" });
  for (let i = 0; i < 100 && !await queue.canResumePersisted(result.taskId); i++) await delay(25);
  await pool.query("UPDATE tasks SET status='running',updated_at=now()-interval '4 minutes' WHERE id=$1", [result.taskId]);
  await new PgComicGeneration(pool).reconcileInterrupted(id => queue.canResumePersisted(id));
  assert.equal((await json<ComicImageRequest>("/generation-requests/" + result.id)).active, false);

  assert.equal((await recover(completed)).taskId, result.taskId);
  completed = await settled(result.id);
  assert.equal(completed.takes[0].state, "recoverable");
  assert.equal(counts.polls, 2);
  assert.equal(counts.downloads, 1);
  await recover(completed);
  completed = await settled(result.id);
  const take = completed.takes[0];
  assert.equal(take.state, "ready");
  assert.equal(counts.submits, 1);
  assert.equal(counts.polls, 2);
  assert.equal(counts.downloads, 2);
  assert.ok(take.mediaId);
  await pool.query("UPDATE lot_comic_drama.cd_generation_requests SET expires_at=now()-interval '1 second' WHERE id=$1", [result.id]);
  assert.equal((await confirm(payable)).taskId, result.taskId);
  assert.equal(counts.publications, 1);
  assert.equal((await request(`/media/${take.mediaId}/links`, "GET", undefined, "fixture-two")).status, 404);
  const confirmed = await json<{ ok: true; selectionRevision: number }>(firstPath + "/keyframe/confirm", "POST", {
    keyframeTakeId: take.id, expectedClipRevision: saved.clip.revision, expectedSelectionRevision: saved.clip.selectionRevision ?? 1,
  });
  assert.equal((await json<ComicKeyframeHistory>(firstPath + "/keyframes")).approvedTakeId, take.id);
  saved = await save(saved.clip);
  assert.equal((await json<ComicKeyframeHistory>(firstPath + "/keyframes")).approvedTakeId, null);
  await json(firstPath + "/keyframe/confirm", "POST", {
    keyframeTakeId: take.id, expectedClipRevision: saved.clip.revision, expectedSelectionRevision: confirmed.selectionRevision,
  }, 409);

  const { id: characterId } = await json<{ id: string }>("/characters", "POST",
    { name: "W5 fixture lead", tags: [], aliases: [], roleKey: "lead", age: "", appearance: "Black hair", personality: "Calm" }, 201);
  const character = "/characters/" + characterId;
  const { id: outfitId } = await json<{ id: string }>(character + "/outfits", "POST", { name: "Raincoat" }, 201);
  const generate = async (target: unknown, loseDelivery = false) => {
    const quote = await json<ComicGenerationQuote>(character + "/generation-preview", "POST", target);
    assert.ok(quote.confirmationId);
    state.failDelivery = loseDelivery;
    const run = await json<ComicImageRequest>(character + "/generate", "POST", { confirmationId: quote.confirmationId }, 202);
    if (loseDelivery) await queue.diagnosePending(0);
    return settled(run.id);
  };
  const slot = await generate({ kind: "slot", key: "front", outfitId }, true);
  const expression = await generate({ kind: "expression", key: "smile" });
  const assets = (await json<ComicCharacterDetail>(character)).assets;
  assert.deepEqual(assets.map(asset => [asset.kind, asset.version, asset.media.id]),
    [["expression", 1, expression.takes[0].mediaId], ["slot", 1, slot.takes[0].mediaId]]);
  assert.equal(counts.references, 1);
  state.next = "unknown";
  const unknown = await generate({ kind: "expression", key: "angry" });
  assert.equal(unknown.takes[0].state, "unknown");
  await json(`/generation-requests/${unknown.id}/recover`, "POST", {}, 409);
  assert.equal((await json<ComicGenerationQuote>(character + "/generation-preview", "POST", { kind: "expression", key: "angry" })).confirmationId, null);
  await json(`/image-takes/${unknown.takes[0].id}/cancel`, "POST", {}, 409);
  await json(`/image-takes/${unknown.takes[0].id}/release`, "POST", {}, 400);
  assert.equal((await request(`/image-takes/${unknown.takes[0].id}/release`, "POST", { acknowledgePossibleCharge: true }, "fixture-two")).status, 404);
  const released = await json<{ state: string }>(`/image-takes/${unknown.takes[0].id}/release`, "POST", { acknowledgePossibleCharge: true });
  assert.equal(released.state, "released");
  assert.equal((await json<{ state: string }>(`/image-takes/${unknown.takes[0].id}/release`, "POST", { acknowledgePossibleCharge: true })).state, "released");
  const unblocked = await json<ComicGenerationQuote>(character + "/generation-preview", "POST", { kind: "expression", key: "angry" });
  assert.ok(unblocked.confirmationId);
  state.failDelivery = true;
  const cancelledRun = await json<ComicImageRequest>(character + "/generate", "POST", { confirmationId: unblocked.confirmationId }, 202);
  const cancelledTake = await json<{ state: string }>(`/image-takes/${cancelledRun.takes[0].id}/cancel`, "POST", {});
  assert.equal(cancelledTake.state, "cancelled");
  assert.ok((await json<ComicGenerationQuote>(character + "/generation-preview", "POST", { kind: "expression", key: "angry" })).confirmationId);
  assert.equal(counts.submits, 4);
  console.log("PASS W5 PG/Redis/HTTP: no submit on preview, quote CAS/expiry, one confirmation, media queue, poll/download recovery, keyframe review, character assets");
}
