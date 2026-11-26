import { logger } from "@lot-agent/core";
import type { PoolClient } from "pg";
import type { DB, StoredAsset } from "../db/database.js";
import { signPrivateMaterial, signPrivateOutput } from "../generation/private-materials.js";
import { assetType, VolcAssetRequestError, VolcAssetsClient } from "./client.js";

type AssetState = "pending" | "creating" | "processing" | "active" | "failed";
interface AssetJob {
  asset_id: string;
  owner_id: string;
  group_id: string | null;
  remote_id: string | null;
  deleted: boolean;
  state: AssetState;
}
interface GroupJob { name: string; creating: boolean; due: boolean }

const POLL_MS = 2_000;
const RETRY = "60 seconds";
const RECONCILE = "5 minutes";

/** Login and new media queue a check for the same Ark material group. */
export async function enqueueVolcGroup(db: DB["pool"] | PoolClient, owner: string) {
  await db.query(`INSERT INTO volc_asset_groups (owner_id, name)
    SELECT id::text, 'lotagent-' || COALESCE(NULLIF(username, ''), id::text) FROM users WHERE id=$1
    ON CONFLICT (owner_id) DO UPDATE SET check_requested=true, run_after=now()
    WHERE NOT volc_asset_groups.check_requested`, [owner]);
}

async function groupId(db: PoolClient, api: VolcAssetsClient, owner: string) {
  await enqueueVolcGroup(db, owner);
  const { rows: [group] } = await db.query<GroupJob>(
    "SELECT name, creating, run_after<=now() AS due FROM volc_asset_groups WHERE owner_id=$1", [owner],
  );
  if (!group?.due) return null;
  let remoteId = await api.findGroup(group.name);
  if (!remoteId && group.creating) {
    // A previous POST may have succeeded even though we did not receive its ID.
    await db.query("UPDATE volc_asset_groups SET run_after=now()+$2::interval WHERE owner_id=$1", [owner, RECONCILE]);
    return null;
  }
  if (!remoteId) {
    await db.query("UPDATE volc_asset_groups SET creating=true, remote_id=NULL WHERE owner_id=$1", [owner]);
    try { remoteId = await api.createGroup(group.name); }
    catch (error) {
      if (error instanceof VolcAssetRequestError && error.rejected) {
        await db.query("UPDATE volc_asset_groups SET creating=false WHERE owner_id=$1", [owner]);
      }
      throw error;
    }
  }
  await db.query("UPDATE volc_asset_groups SET remote_id=$2, creating=false, check_requested=false WHERE owner_id=$1", [owner, remoteId]);
  return remoteId;
}

function sourceUrl(source: StoredAsset) {
  const path = source.type === "upload" ? "/static/uploads/" : "/static/assets/";
  const relative = path + encodeURIComponent(source.storage_key);
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("PUBLIC_BASE_URL 未配置");
  if (!source.is_private) return base + relative;
  if (source.type === "upload") return signPrivateMaterial(source, { publicBaseUrl: base });
  const url = signPrivateOutput(source.user_id, relative);
  if (url === relative) throw new Error("私有素材访问服务未配置");
  return base + url;
}

async function syncAsset(db: PoolClient, api: VolcAssetsClient, job: AssetJob) {
  const key = [job.asset_id, job.owner_id];
  const remove = () => db.query("DELETE FROM volc_assets WHERE asset_id=$1 AND owner_id=$2 AND deleted", key);
  const delay = (interval: string) => db.query("UPDATE volc_assets SET run_after=now()+$3::interval WHERE asset_id=$1 AND owner_id=$2", [...key, interval]);
  const setState = (state: AssetState, remoteId = job.remote_id, interval = "0 seconds") => db.query(
    "UPDATE volc_assets SET state=$3, remote_id=$4, run_after=now()+$5::interval WHERE asset_id=$1 AND owner_id=$2",
    [...key, state, remoteId, interval],
  );
  // A deleted or transferred file may still have a pending provider create to reconcile.
  if (job.state === "creating" && job.group_id) {
    const remoteId = await api.findAsset(job.asset_id, job.group_id);
    if (remoteId) await setState("processing", remoteId);
    else await delay(RECONCILE);
    return;
  }
  if (job.deleted) {
    if (job.remote_id) await api.deleteAsset(job.remote_id);
    await remove();
    return;
  }
  if (job.remote_id) {
    const state = (await api.status(job.remote_id)).toLowerCase() as AssetState;
    await setState(state, job.remote_id, state === "processing" ? "5 seconds" : undefined);
    return;
  }

  const id = await groupId(db, api, job.owner_id);
  if (!id) {
    await delay(RETRY);
    return;
  }
  const { rows: [source] } = await db.query<StoredAsset>("SELECT * FROM assets WHERE id=$1 AND user_id=$2", key);
  const type = source && assetType(source.mime);
  if (!type) {
    await setState("failed");
    return;
  }
  const url = sourceUrl(source);
  const started = await db.query(
    "UPDATE volc_assets SET state='creating', group_id=$3 WHERE asset_id=$1 AND owner_id=$2 AND NOT deleted", [...key, id],
  );
  if (!started.rowCount) return;
  try {
    await setState("processing", await api.createAsset(id, job.asset_id, type, url), "5 seconds");
  } catch (error) {
    if (error instanceof VolcAssetRequestError && error.rejected) {
      await setState(error.status === 400 ? "failed" : "pending", null, RETRY);
    }
    throw error;
  }
}

/** One runner per API instance, with a per-owner database lock shared across instances. */
export function startVolcAssetSync(db: Pick<DB, "getUserApiKey" | "pool">, baseUrl: string, managedKeys: boolean) {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  const runOwner = async (owner: string) => {
    const connection = await db.pool.connect();
    const lock = `volc-asset-sync:${owner}`;
    let locked = false;
    let job: AssetJob | undefined;
    try {
      locked = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lock])).rows[0].locked;
      if (!locked || abort.signal.aborted) return;
      job = (await connection.query<AssetJob>(`SELECT * FROM volc_assets
        WHERE owner_id=$1 AND run_after<=now() AND (deleted OR state NOT IN ('active', 'failed'))
        ORDER BY run_after, asset_id LIMIT 1`, [owner])).rows[0];
      const key = await db.getUserApiKey(owner, managedKeys);
      if (!key) throw new Error("素材同步缺少用户凭证");
      const api = new VolcAssetsClient(baseUrl, key, abort.signal);
      if (job) await syncAsset(connection, api, job);
      else await groupId(connection, api, owner);
    } catch (error) {
      if (!abort.signal.aborted) {
        // Never log the transport error: it can contain a signature, credential, or a material URL.
        logger.warn("Volc asset sync delayed", { owner, assetId: job?.asset_id, status: error instanceof VolcAssetRequestError ? error.status : undefined });
      }
      await connection.query("UPDATE volc_asset_groups SET run_after=now()+$2::interval WHERE owner_id=$1 AND check_requested", [owner, RETRY]);
      if (job) {
        await connection.query("UPDATE volc_assets SET run_after=now()+$3::interval WHERE owner_id=$1 AND asset_id=$2", [owner, job.asset_id, RETRY]);
      }
    } finally {
      try {
        if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]);
        connection.release();
      } catch { connection.release(true); }
    }
  };
  const tick = async () => {
    const { rows } = await db.pool.query<{ owner_id: string }>(`
      SELECT owner_id FROM (
        SELECT owner_id, run_after FROM volc_asset_groups WHERE check_requested
        UNION ALL
        SELECT owner_id, run_after FROM volc_assets WHERE deleted OR state NOT IN ('active', 'failed')
      ) work WHERE run_after<=now() GROUP BY owner_id ORDER BY min(run_after), owner_id LIMIT 4`);
    for (const result of await Promise.allSettled(rows.map(({ owner_id }) => runOwner(owner_id)))) {
      if (result.status === "rejected") logger.warn("Volc asset background operation failed");
    }
  };
  const timer = setInterval(() => {
    if (running) return;
    running = tick().catch(() => logger.warn("Volc asset sync queue unavailable")).finally(() => { running = undefined; });
  }, POLL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    abort.abort();
    await running;
  };
}
