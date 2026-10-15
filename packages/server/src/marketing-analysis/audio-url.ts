import { createHash } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { SecretBox } from "../auth/secret-box.js";
import { AnalysisStorage } from "./storage.js";
import { readAnalysisFile } from "./private-files.js";
import { AnalysisError } from "./errors.js";

const maxAudioBytes = 180 * 16000 * 2 + 4096;
/** PUBLIC_BASE_URL is server configuration, never a client-supplied origin. */
export function analysisAudioUrl(publicBaseUrl: string, path: string) {
  let base: URL;
  try { base = new URL(publicBaseUrl); } catch { throw new AnalysisError("ASR_PUBLIC_URL_REQUIRED", 503); }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new AnalysisError("ASR_PUBLIC_URL_REQUIRED", 503);
  return `${base.href.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

/** A short-lived, encrypted capability lets the model fetch only this task's WAV.
 * The API and media worker share the private volume and SECRET_MASTER_KEY. */
export async function withAnalysisAudioUrl<T>(input: {
  directory: string; ownerId: string; analysisId: string; audio: Buffer;
  publicBaseUrl: string; masterKey: string;
}, use: (url: string, audioHash: string) => Promise<T>): Promise<T> {
  if (!input.masterKey) throw new AnalysisError("ANALYSIS_CONFIG_REQUIRED", 503);
  if (!input.audio.length || input.audio.length > maxAudioBytes) throw new AnalysisError("MODEL_REQUEST_LIMIT");
  const audioHash = createHash("sha256").update(input.audio).digest("hex");
  const claim = { ownerId: input.ownerId, analysisId: input.analysisId, audioHash, expires: Date.now() + 10 * 60_000 };
  const token = Buffer.from(new SecretBox(input.masterKey).seal(JSON.stringify(claim))).toString("base64url");
  const url = analysisAudioUrl(input.publicBaseUrl, `api/public/marketing-analysis-audio/${token}`);
  const path = join(input.directory, "speech.wav");
  await rm(path, { force: true });
  await writeFile(path, input.audio, { mode: 0o600, flag: "wx" });
  try { return await use(url, audioHash); }
  finally { await rm(path, { force: true }); }
}

export function createAnalysisAudioRoutes(root: string, masterKey = process.env.SECRET_MASTER_KEY ?? "") {
  const app = new Hono(); const storage = new AnalysisStorage(root);
  app.get("/:token", async c => {
    try {
      const token = c.req.param("token");
      if (!masterKey || token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
      const encrypted = Buffer.from(token, "base64url").toString("utf8");
      if (Buffer.from(encrypted).toString("base64url") !== token || !encrypted.startsWith("enc:v1:")) throw new Error();
      const parts = encrypted.slice(7).split(":");
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9+/]+={0,2}$/.test(part) || Buffer.from(part, "base64").toString("base64") !== part)) throw new Error();
      const claim = JSON.parse(new SecretBox(masterKey).open(encrypted));
      if (typeof claim.ownerId !== "string" || !claim.ownerId || typeof claim.analysisId !== "string"
        || !/^[a-f0-9-]{36}$/i.test(claim.analysisId) || !/^[a-f0-9]{64}$/.test(claim.audioHash)
        || !Number.isSafeInteger(claim.expires) || claim.expires < Date.now() || claim.expires > Date.now() + 10 * 60_000) throw new Error();
      const bytes = await readAnalysisFile(await storage.directory(claim.ownerId, claim.analysisId), "speech.wav", maxAudioBytes);
      if (createHash("sha256").update(bytes).digest("hex") !== claim.audioHash) throw new Error();
      return c.body(new Uint8Array(bytes), 200, { "Content-Type": "audio/wav", "Content-Length": String(bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    } catch { return c.text("Not found", 404); }
  });
  return app;
}
