import assert from "node:assert/strict";
import type { Pool } from "pg";
import { PgComicDramaRepository } from "../../src/comic-drama/repository.js";
import { reconcileComicSettlements } from "../../src/comic-drama/settlement.js";
import { TokenhubBillingLogs } from "../../src/tokenhub/billing-logs.js";

export async function verifyComicSettlements(pool: Pool, owner: string, videoEpisode: string) {
  const { rows } = await pool.query<{ id: string; seriesId: string; model: string; task: string | null; request: string; video: boolean }>(`
    SELECT t.id,r.series_id AS "seriesId", t.input->>'modelId' AS model, t.vendor_id AS task,
      coalesce(t.gateway_request_id,i.gateway_request_id) AS request, t.video_version IS NOT NULL AS video
    FROM lot_comic_drama.cd_takes t
    JOIN lot_comic_drama.cd_generation_requests r ON (r.owner_id,r.id)=(t.owner_id,t.request_id)
    LEFT JOIN image_call_receipts i ON i.user_id=t.owner_id::text AND i.task_id=r.task_id AND i.slot=t.slot
    WHERE t.owner_id=$1 AND t.status='ready' AND r.series_id IS NOT NULL AND coalesce(t.gateway_request_id,i.gateway_request_id) IS NOT NULL
    ORDER BY t.created_at,t.id`, [owner]);
  const [video, unmatched] = rows.filter(row => row.video && row.seriesId === videoEpisode);
  const image = rows.find(row => !row.video);
  assert.ok(video?.task && unmatched && image);
  await pool.query("UPDATE users SET external_user_id=201,managed_token_id=301,managed_api_key='fixture-managed-key' WHERE id=$1", [owner]);

  const repo = new PgComicDramaRepository(pool);
  const costs = async (series: string) => (await repo.get(owner, series)).summary.costs!;
  const before = await costs(videoEpisode);
  const consume = { type: 2, user_id: 201, token_id: 301 };
  const final = { ...consume, model_name: video.model, quota: 125_000,
    other: JSON.stringify({ task_id: video.task, actual_quota: 125_000, video_actual_quota: 125_000 }) };
  const reserved = { ...consume, request_id: video.request, model_name: video.model, quota: 0,
    other: JSON.stringify({ task_id: video.task, is_task: true, pricing_scheme: "video_token" }) };
  const wrongAccount = { ...final, user_id: 202 };
  const wrongToken = { ...final, token_id: 302 };
  const wrongModel = { ...final, model_name: "different-video-model" };
  const refund = { ...final, type: 6 };
  const imageLog = { ...consume, request_id: image.request, model_name: image.model, quota: 20_000, other: "{}" };
  let ledgerCurrency = "CNY";
  let ledger = [reserved, wrongAccount, wrongToken, wrongModel, refund];
  const billing = new TokenhubBillingLogs("https://fixture.invalid/v1", async (input, init) => {
    assert.equal(init?.redirect, "error");
    const url = new URL(String(input));
    switch (url.pathname) {
      case "/api/status":
        return Response.json({ success: true, data: {
          quota_display_type: ledgerCurrency, quota_per_unit: 500_000, usd_exchange_rate: 7,
        } });
      case "/api/log/token":
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-managed-key");
        return Response.json({ success: true, data: ledger });
      default: throw new Error("Unexpected gateway path");
    }
  });
  const db = { pool, getUserApiKey: async (account: string) => account === owner ? "fixture-managed-key" : null };
  const run = () => reconcileComicSettlements(db, billing, true, AbortSignal.timeout(10_000));
  const read = async (id: string) => (await pool.query(`SELECT settled_amount_micros::int AS amount, settled_currency AS currency,
    settled_at::text AS at, settled_source AS source FROM lot_comic_drama.cd_takes WHERE id=$1`, [id])).rows[0];
  const retry = () => pool.query("UPDATE lot_comic_drama.cd_takes SET settlement_checked_at=NULL WHERE owner_id=$1", [owner]);

  await run();
  assert.equal((await read(video.id)).amount, null, "Only a final consume log from the exact gateway account, token and model settles the take");
  await retry();
  ledger = [reserved, final, final];
  await Promise.all([run(), run()]);
  const actual = await read(video.id);
  assert.deepEqual([actual.currency, actual.amount, actual.source], ["CNY", 1_750_000, "tokenhub:task:" + video.task]);
  const after = await costs(videoEpisode);
  assert.deepEqual(after.settled, [{ currency: "CNY", amountMicros: 1_750_000 }]);
  assert.ok(after.quotedUnbilled[0].amountMicros < before.quotedUnbilled[0].amountMicros);
  assert.equal((await read(unmatched.id)).amount, null);
  assert.ok(after.pendingReconcileCount > 0);
  const imageBefore = await costs(image.seriesId);

  await retry();
  ledgerCurrency = "USD";
  ledger = [reserved, final, imageLog, imageLog];
  await run();
  assert.deepEqual(await read(video.id), actual, "A replay keeps the original amount, currency and timestamp");
  const imageActual = await read(image.id);
  assert.deepEqual([imageActual.currency, imageActual.amount, imageActual.source], ["USD", 40_000, "tokenhub:request:" + image.request]);
  assert.ok(((await costs(image.seriesId)).quotedUnbilled[0]?.amountMicros ?? 0) < imageBefore.quotedUnbilled[0].amountMicros);
  console.log("PASS settlements: CNY video and USD image, owner/token/model match, reserve and refund ignored, duplicate replay, missing charge kept pending");
}
