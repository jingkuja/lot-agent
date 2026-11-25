import type { DB } from "../db/database.js";
import type { TokenhubBillingLogs, TokenhubChargeLog } from "../tokenhub/billing-logs.js";
import { PgComicDramaRepository } from "./repository.js";

type PendingTake = {
  id: string;
  owner: string;
  externalUserId: string | null;
  managedTokenId: string | null;
  model: string;
  video: boolean;
  request: string | null;
  task: string | null;
};
const upstreamId = /^[\w.:-]{1,250}$/;

function matchCharge(take: PendingTake, logs: TokenhubChargeLog[]) {
  const ownLogs = logs.filter(log => log.model_name === take.model && !log.other.invalid
    && (!take.externalUserId || take.externalUserId === "0" || String(log.user_id) === take.externalUserId)
    && (!take.managedTokenId || String(log.token_id) === take.managedTokenId));
  const submission = take.request ? ownLogs.filter(log => log.request_id === take.request) : [];
  if (!take.video) {
    const imageCharges = submission.filter(log => !log.other.is_task && !log.other.task_id);
    const log = imageCharges[0];
    return log && imageCharges.every(entry => entry.quota === log.quota) && upstreamId.test(take.request!)
      ? { quota: log.quota, source: `tokenhub:request:${take.request}` } : null;
  }

  // The task log at submission may record a zero-cost reservation. A final
  // video snapshot log carries the full charge and the gateway's public task ID.
  const submittedTask = submission.find(log => typeof log.other.task_id === "string")?.other.task_id;
  const task = take.task ?? submittedTask;
  if (typeof task !== "string" || !upstreamId.test(task)) return null;
  if (submission.some(log => typeof log.other.task_id === "string" && log.other.task_id !== task)) return null;
  const charges = ownLogs.filter(log => log.other.task_id === task
    && log.other.actual_quota === log.quota && log.other.video_actual_quota === log.quota);
  const log = charges[0];
  return log && charges.every(entry => entry.quota === log.quota)
    ? { quota: log.quota, source: `tokenhub:task:${task}` } : null;
}

export async function reconcileComicSettlements(
  db: Pick<DB, "pool" | "getUserApiKey">, gateway: Pick<TokenhubBillingLogs, "charges" | "units">,
  managed: boolean, signal: AbortSignal,
) {
  const { rows } = await db.pool.query<PendingTake>(`
    WITH due AS (
      SELECT t.id,t.owner_id
      FROM lot_comic_drama.cd_takes t
      WHERE t.settled_amount_micros IS NULL
        AND (t.status IN ('ready','unknown','released') OR t.submit_state IN ('accepted','output','unknown') OR t.gateway_http_status>=500)
        AND (t.settlement_checked_at IS NULL OR t.settlement_checked_at<now()-interval '1 minute')
      ORDER BY t.settlement_checked_at NULLS FIRST,t.created_at,t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED
    ), checked AS (
      UPDATE lot_comic_drama.cd_takes t SET settlement_checked_at=now()
      FROM due WHERE (t.owner_id,t.id)=(due.owner_id,due.id)
      RETURNING t.*
    )
    SELECT t.id,t.owner_id AS owner,u.external_user_id::text AS "externalUserId",
      CASE WHEN u.managed_api_key IS NOT NULL THEN u.managed_token_id::text END AS "managedTokenId",
      t.input->>'modelId' AS model,t.video_version IS NOT NULL AS video,
      coalesce(t.gateway_request_id,i.gateway_request_id) AS request,coalesce(t.vendor_id,i.vendor_id) AS task
    FROM checked t JOIN users u ON u.id=t.owner_id
    JOIN lot_comic_drama.cd_generation_requests r ON (r.owner_id,r.id)=(t.owner_id,t.request_id)
    LEFT JOIN image_call_receipts i ON i.user_id=t.owner_id::text AND i.task_id=r.task_id AND i.slot=t.slot
    WHERE r.confirmed_at IS NOT NULL AND (coalesce(t.gateway_request_id,i.gateway_request_id) IS NOT NULL
      OR (t.video_version IS NOT NULL AND t.vendor_id IS NOT NULL))
  `);
  if (!rows.length) return;
  const units = await gateway.units(signal);
  const repo = new PgComicDramaRepository(db.pool);
  const byOwner = new Map<string, PendingTake[]>();
  for (const take of rows) {
    const takes = byOwner.get(take.owner) ?? [];
    takes.push(take);
    byOwner.set(take.owner, takes);
  }
  const owners = [...byOwner];
  for (let offset = 0; offset < owners.length && !signal.aborted; offset += 4) {
    const results = await Promise.allSettled(owners.slice(offset, offset + 4).map(async ([owner, takes]) => {
      const key = await db.getUserApiKey(owner, managed);
      if (!key) return;
      const logs = await gateway.charges(key, signal);
      for (const take of takes) {
        signal.throwIfAborted();
        const charge = matchCharge(take, logs);
        if (!charge) continue;
        const amountMicros = Math.round(charge.quota / units.quotaPerUnit * units.exchangeRate * 1_000_000);
        if (Number.isSafeInteger(amountMicros)) {
          await repo.recordTakeSettlement(owner, take.id, { amountMicros, currency: units.currency, source: charge.source }, take);
        }
      }
    }));
    if (!signal.aborted && results.some(result => result.status === "rejected")) {
      console.warn("[comic-drama] some take settlements could not be checked");
    }
  }
}

export function startComicSettlementSync(db: DB, gateway: TokenhubBillingLogs, managed: boolean) {
  const control = new AbortController();
  let active: Promise<void> | undefined;
  const tick = () => {
    if (active) return;
    const signal = AbortSignal.any([control.signal, AbortSignal.timeout(50_000)]);
    active = reconcileComicSettlements(db, gateway, managed, signal)
      .catch(() => { if (!control.signal.aborted) console.warn("[comic-drama] take settlement sync unavailable"); })
      .finally(() => { active = undefined; });
  };
  tick();
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    control.abort();
    await active;
  };
}
