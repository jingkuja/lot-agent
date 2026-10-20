import type { Context } from "hono";
import { SecretBox } from "../auth/secret-box.js";
import { GenerationError } from "./errors.js";

export interface PrivateMaterialAsset {
  id: string;
  user_id: string;
  storage_key: string;
  url: string;
  type: string;
  is_private?: boolean;
}

export interface PrivateMaterialOptions {
  masterKey?: string;
  now?: () => number;
  publicBaseUrl?: string;
}

interface UploadLookup {
  getUploadByStorageKey(key: string): Promise<PrivateMaterialAsset | null | undefined>;
}

const TOKEN_PARAMETER = "material_token";
const TOKEN_TTL_MS = 10 * 60_000;
const UPLOAD_PATH = "/static/uploads/";
const PURPOSE = "marketing-material:v1";

function safeKey(key: string): boolean {
  return !!key && key.length <= 500 && !/[\\/\u0000-\u001f\u007f]/.test(key) && !key.includes("..");
}

function publicBase(options: PrivateMaterialOptions): string {
  const value = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? "";
  if (!value) return "";
  const base = new URL(value);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new GenerationError("CONFIG_MISSING", "素材公网地址配置无效。");
  }
  return base.href.replace(/\/+$/, "");
}

function secretBox(options: PrivateMaterialOptions): SecretBox {
  const key = options.masterKey ?? process.env.SECRET_MASTER_KEY ?? "";
  if (!key) throw new GenerationError("CONFIG_MISSING", "私有素材访问服务未配置。");
  return new SecretBox(key);
}

/** The stored URL remains a stable identity. Only response/submission URLs expire. */
export function signPrivateMaterial(asset: PrivateMaterialAsset, options: PrivateMaterialOptions = {}): string {
  if (!asset.is_private || asset.type !== "upload") return asset.url;
  if (!asset.id || !asset.user_id || !safeKey(asset.storage_key)) throw new Error("素材不存在。");
  const now = (options.now ?? Date.now)();
  const claim = { purpose: PURPOSE, id: asset.id, owner: asset.user_id, key: asset.storage_key, expires: now + TOKEN_TTL_MS };
  const token = Buffer.from(secretBox(options).seal(JSON.stringify(claim))).toString("base64url");
  return `${publicBase(options)}${UPLOAD_PATH}${encodeURIComponent(asset.storage_key)}?${TOKEN_PARAMETER}=${token}`;
}

function validCapability(token: string | undefined, asset: PrivateMaterialAsset, options: PrivateMaterialOptions): boolean {
  if (!token || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) return false;
  try {
    const envelope = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(envelope).toString("base64url") !== token || !envelope.startsWith("enc:v1:")) return false;
    const parts = envelope.slice(7).split(":");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9+/]+={0,2}$/.test(part) || Buffer.from(part, "base64").toString("base64") !== part)) return false;
    const claim = JSON.parse(secretBox(options).open(envelope));
    const now = (options.now ?? Date.now)();
    return claim?.purpose === PURPOSE && claim.id === asset.id && claim.owner === asset.user_id && claim.key === asset.storage_key
      && Number.isSafeInteger(claim.expires) && claim.expires > now && claim.expires <= now + TOKEN_TTL_MS;
  } catch { return false; }
}

/** Called before reading any bytes. Missing rows and unavailable auth fail closed. */
export function createUploadAccessGuard(
  db: UploadLookup,
  sessions: { resolve(token: string): Promise<{ userId: string } | null | undefined> },
  options: PrivateMaterialOptions = {}
) {
  return async (c: Context, filename: string): Promise<boolean> => {
    if (!safeKey(filename)) return false;
    try {
      const asset = await db.getUploadByStorageKey(filename);
      if (!asset || asset.type !== "upload" || asset.storage_key !== filename) return false;
      if (!asset.is_private) return true;
      if (validCapability(c.req.query(TOKEN_PARAMETER), asset, options)) return true;
      const header = c.req.header("Authorization");
      const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token) return false;
      return (await sessions.resolve(token))?.userId === asset.user_id;
    } catch { return false; }
  };
}

/** Only this app's upload origin is a local lookup. External URLs retain the
 * generation runner's existing provider and SSRF validation. */
export async function resolveMaterialReference(
  db: UploadLookup,
  userId: string,
  url: string,
  options: PrivateMaterialOptions = {}
): Promise<string> {
  let rawKey: string | undefined;
  if (url.startsWith(UPLOAD_PATH)) {
    rawKey = url.slice(UPLOAD_PATH.length);
  } else {
    const base = publicBase(options);
    if (!base) return url;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return url; }
    const prefix = new URL(`${base}${UPLOAD_PATH}`);
    if (parsed.origin !== prefix.origin || !parsed.pathname.startsWith(prefix.pathname)) return url;
    if (parsed.username || parsed.password) throw new Error("素材地址无效。");
    // Preserve encoded traversal components until they have been checked below.
    rawKey = parsed.pathname.slice(prefix.pathname.length) + parsed.search + parsed.hash;
  }
  if (rawKey.includes("#")) throw new Error("素材地址无效。");
  let key: string;
  try { key = decodeURIComponent(rawKey.split("?")[0]); } catch { throw new Error("素材地址无效。"); }
  if (!safeKey(key)) throw new Error("素材地址无效。");
  const asset = await db.getUploadByStorageKey(key);
  if (!asset || asset.type !== "upload" || asset.storage_key !== key || asset.user_id !== userId) throw new Error("素材不存在。");
  const resolved = signPrivateMaterial(asset, options);
  // Preserve the worker's externally reachable form even when legacy rows
  // were stored with a host-relative URL before PUBLIC_BASE_URL was configured.
  return resolved.startsWith("/static/") ? `${publicBase(options)}${resolved}` : resolved;
}
