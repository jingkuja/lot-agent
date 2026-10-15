/** Public-origin acceptance against this API's shared private volume. No model calls. */
import "../src/load-env.js";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisStorage } from "../src/marketing-analysis/storage.js";
import { withAnalysisAudioUrl } from "../src/marketing-analysis/audio-url.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const storage = new AnalysisStorage(resolve(root, "data/marketing-analysis"));
const analysisId = randomUUID();
const directory = await storage.directory(`acceptance-${analysisId}`, analysisId);
// One second of synthetic silence. Never expose user audio in a reachability probe.
const audio = Buffer.alloc(44 + 32000);
audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(32000, 40);
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), modelCalls: 0 };
let issuedUrl = "";
try {
  await withAnalysisAudioUrl({ directory, ownerId: `acceptance-${analysisId}`, analysisId, audio,
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "", masterKey: process.env.SECRET_MASTER_KEY ?? "" }, async (url, hash) => {
    issuedUrl = url;
    report.origin = new URL(url).origin;
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
    report.status = response.status;
    report.contentType = response.headers.get("content-type");
    report.cacheControl = response.headers.get("cache-control");
    if (response.status !== 200 || response.headers.get("content-type") !== "audio/wav"
      || Number(response.headers.get("content-length")) !== audio.length) {
      await response.body?.cancel(); throw new Error("PUBLIC_AUDIO_RESPONSE_INVALID");
    }
    report.hashMatches = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex") === hash;
    if (!report.hashMatches || report.cacheControl !== "private, no-store") throw new Error("PUBLIC_AUDIO_CONTENT_INVALID");
  });
  const removed = await fetch(issuedUrl, { redirect: "error", signal: AbortSignal.timeout(15000) });
  report.afterRemovalStatus = removed.status; await removed.body?.cancel();
  if (removed.status !== 404) throw new Error("PUBLIC_AUDIO_NOT_REVOKED");
  report.passed = true;
} catch (error) {
  report.passed = false;
  const code = error instanceof Error ? error.message : "";
  report.error = /^[A-Z_]+$/.test(code) ? code : "PUBLIC_AUDIO_CHECK_FAILED";
  process.exitCode = 1;
} finally {
  await rm(dirname(directory), { recursive: true, force: true });
  // Capability URLs, source links and credentials are deliberately excluded.
  console.log(JSON.stringify(report));
}
