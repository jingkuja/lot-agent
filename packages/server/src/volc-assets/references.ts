import { setTimeout as wait } from "node:timers/promises";
import type { DB } from "../db/database.js";
import { GenerationError } from "../generation/errors.js";
import { resolveMaterialReference, signPrivateOutput } from "../generation/private-materials.js";
import { assetType } from "./client.js";

type ReferenceDb = Pick<DB, "pool" | "getUploadByStorageKey" | "getGeneratedByStorageKey">;

export function seedanceUsesAssetLibrary(): boolean {
  return process.env.SEEDANCE_USE_ASSET_URLS !== "1";
}

/** Resolve an owned Seedance reference to an Ark asset or a vendor-readable URL. */
export async function resolveSeedanceReference(db: ReferenceDb, owner: string, url: string, signal?: AbortSignal): Promise<string> {
  const useLibrary = seedanceUsesAssetLibrary();
  if (/^asset:\/\//i.test(url)) {
    if (!useLibrary) throw new GenerationError("GENERATION_FAILED", "当前 Seedance 渠道使用素材链接，请提供图片、视频或音频 URL。");
    const id = /^asset:\/\/([A-Za-z0-9_-]{1,128})$/i.exec(url)?.[1];
    if (!id) throw new GenerationError("GENERATION_FAILED", "素材地址无效。");
    const { rows } = await db.pool.query<{ owner_id: string; state: string; deleted: boolean }>(
      "SELECT owner_id, state, deleted FROM volc_assets WHERE remote_id=$1", [id],
    );
    if (rows.length && !rows.some(row => row.owner_id === owner && row.state === "active" && !row.deleted)) {
      throw new GenerationError("GENERATION_FAILED", "素材不存在。");
    }
    return url;
  }
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const local = base && url.startsWith(base + "/") ? url.slice(base.length) : url;
  const parts = /^\/static\/(uploads|assets)\/([^/?#]+)(?:\?[^#]*)?$/.exec(local);
  if (!parts || (!useLibrary && parts[1] === "uploads")) return resolveMaterialReference(db, owner, url);
  const key = decodeURIComponent(parts[2]);
  if (!key || /[\\/\u0000-\u001f\u007f]/.test(key) || key.includes("..")) {
    throw new GenerationError("GENERATION_FAILED", "素材地址无效。");
  }
  const asset = parts[1] === "uploads" ? await db.getUploadByStorageKey(key) : await db.getGeneratedByStorageKey(key);
  if (!asset || asset.user_id !== owner || asset.storage_key !== key || !assetType(asset.mime)) {
    throw new GenerationError("GENERATION_FAILED", "素材不存在。");
  }

  if (!useLibrary) {
    const path = `/static/assets/${encodeURIComponent(key)}`;
    if (!asset.is_private) return (base ?? "") + path;
    const signed = signPrivateOutput(owner, path);
    if (signed === path) throw new GenerationError("CONFIG_MISSING", "私有素材访问服务未配置。");
    return (base ?? "") + signed;
  }

  // Existing uploads and generated assets are queued when first referenced. The asset lock serializes this insert with deletion.
  await db.pool.query(`INSERT INTO volc_assets (asset_id, owner_id)
    SELECT id, user_id FROM assets WHERE id=$1 AND user_id=$2 FOR SHARE
    ON CONFLICT (asset_id, owner_id) DO NOTHING`, [asset.id, owner]);
  const deadline = Date.now() + 120_000;
  do {
    signal?.throwIfAborted();
    const { rows: [row] } = await db.pool.query<{ remote_id: string | null; state: string }>(`
      SELECT remote_id, state FROM volc_assets WHERE asset_id=$1 AND owner_id=$2 AND NOT deleted`, [asset.id, owner]);
    if (!row) throw new GenerationError("GENERATION_FAILED", "素材不存在。");
    if (row.state === "active" && row.remote_id) return `asset://${row.remote_id}`;
    if (row.state === "failed") throw new GenerationError("MATERIAL_SYNC_FAILED", "火山素材库处理失败，请更换素材后重试。");
    await wait(2_000, undefined, { signal });
  } while (Date.now() < deadline);
  throw new GenerationError("MATERIAL_SYNC_PENDING", "素材仍在同步到火山素材库，请稍后重试。");
}
