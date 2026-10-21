import { createHash } from "node:crypto";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Hono } from "hono";
import { SecretBox } from "../auth/secret-box.js";
import { PresenterError } from "./errors.js";

/** Private working files of each draft: voice takes, prepared inputs and downloaded clips.
 * Nothing here is served statically; vendors read inputs only through signed links. */
export const presenterRoot = (dataRoot: string) => resolve(dataRoot, "digital-presenter");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** `<uuid>.ext` at the draft root, or `jobs/<task uuid>/<name>.ext` for one job's files. */
const FILE = /^(?:[a-f0-9-]{36}\.(?:wav|jpg|mp4)|jobs\/[a-f0-9-]{36}\/[a-z0-9-]{1,40}\.(?:wav|jpg|mp4))$/i;
const TYPES: Record<string, string> = { wav: "audio/wav", jpg: "image/jpeg", mp4: "video/mp4" };
const MAX_BYTES = 300 * 1024 * 1024;
/** The vendor queue (VideoRetalk runs one task at a time) may start well after submission. */
export const PRESENTER_LINK_TTL_MS = 3 * 60 * 60_000;
const PURPOSE = "digital-presenter-media:v1";

export function presenterPath(dataRoot: string, projectId: string, file: string) {
  if (!uuid.test(projectId) || !FILE.test(file)) throw new PresenterError("文件不可用。", 404);
  return resolve(presenterRoot(dataRoot), projectId, file);
}

/** An existing file inside the draft's own folder, never through a link elsewhere. */
export async function presenterFile(dataRoot: string, projectId: string, file: unknown) {
  if (typeof file !== "string") throw new PresenterError("文件不可用。", 404);
  const path = presenterPath(dataRoot, projectId, file);
  const root = await realpath(resolve(presenterRoot(dataRoot), projectId)).catch(() => "");
  const real = await realpath(path).catch(() => "");
  if (!root || !real.startsWith(root + sep) || (await stat(real)).size > MAX_BYTES) throw new PresenterError("文件不可用。", 404);
  return real;
}

export async function removePresenterFiles(dataRoot: string, projectId: string) {
  if (!uuid.test(projectId)) return;
  await rm(resolve(presenterRoot(dataRoot), projectId), { recursive: true, force: true });
}

function publicBase(value = process.env.PUBLIC_BASE_URL ?? "") {
  let base: URL;
  try { base = new URL(value); } catch { throw new PresenterError("素材公网地址尚未配置，请联系管理员。", 503); }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new PresenterError("素材公网地址配置无效。", 503);
  return base.href.replace(/\/+$/, "");
}

/** A short-lived encrypted capability for one file, bound to its content hash. */
export async function signPresenterFile(dataRoot: string, projectId: string, file: string, options: { masterKey?: string; publicBaseUrl?: string; now?: number } = {}) {
  const key = options.masterKey ?? process.env.SECRET_MASTER_KEY ?? "";
  if (!key) throw new PresenterError("私有素材访问服务未配置。", 503);
  const hash = createHash("sha256").update(await readFile(await presenterFile(dataRoot, projectId, file))).digest("hex");
  const claim = { purpose: PURPOSE, projectId, file, hash, expires: (options.now ?? Date.now()) + PRESENTER_LINK_TTL_MS };
  const token = Buffer.from(new SecretBox(key).seal(JSON.stringify(claim))).toString("base64url");
  const ext = file.split(".").pop();
  // The extension lets vendors that sniff the URL see the media type.
  return `${publicBase(options.publicBaseUrl)}/api/public/digital-presenter-media/${token}.${ext}`;
}

/** Public, unauthenticated: only a valid unexpired capability reads its exact file. */
export function createPresenterMediaRoutes(dataRoot: string, masterKey = process.env.SECRET_MASTER_KEY ?? "") {
  const app = new Hono();
  app.get("/:token", async c => {
    try {
      const token = c.req.param("token").replace(/\.(wav|jpg|mp4)$/, "");
      if (!masterKey || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
      const envelope = Buffer.from(token, "base64url").toString("utf8");
      if (Buffer.from(envelope).toString("base64url") !== token || !envelope.startsWith("enc:v1:")) throw new Error();
      const claim = JSON.parse(new SecretBox(masterKey).open(envelope));
      const now = Date.now();
      if (claim?.purpose !== PURPOSE || typeof claim.projectId !== "string" || typeof claim.file !== "string" || !/^[a-f0-9]{64}$/.test(claim.hash)
        || !Number.isSafeInteger(claim.expires) || claim.expires < now || claim.expires > now + PRESENTER_LINK_TTL_MS) throw new Error();
      const bytes = await readFile(await presenterFile(dataRoot, claim.projectId, claim.file));
      if (createHash("sha256").update(bytes).digest("hex") !== claim.hash) throw new Error();
      return c.body(new Uint8Array(bytes), 200, { "Content-Type": TYPES[claim.file.split(".").pop()!.toLowerCase()], "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    } catch { return c.text("Not found", 404); }
  });
  return app;
}
