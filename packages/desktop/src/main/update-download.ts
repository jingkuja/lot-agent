import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateArtifact } from "./update-manifest.js";

export async function fetchManifest(url: URL, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { redirect: "error", signal, headers: { "Cache-Control": "no-cache" } });
  if (!response.ok || !response.body) throw new Error("Update feed unavailable");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 128 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("Manifest too large"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function verifyArtifact(file: string, artifact: UpdateArtifact): Promise<boolean> {
  try {
    if ((await stat(file)).size !== artifact.size) return false;
    const hash = createHash("sha512");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("base64") === artifact.sha512;
  } catch { return false; }
}

export async function downloadArtifact(base: URL, artifact: UpdateArtifact, target: string, signal: AbortSignal, progress: (percent: number) => void): Promise<void> {
  if (await verifyArtifact(target, artifact)) { progress(100); return; }
  const partial = `${target}.partial`;
  await rm(partial, { force: true });
  try {
    const response = await fetch(new URL(artifact.file, base), { signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Update download unavailable");
    const hash = createHash("sha512");
    let size = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > artifact.size) { callback(new Error("Update exceeds declared size")); return; }
      hash.update(chunk);
      progress(Math.floor(size * 100 / artifact.size));
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
    if (size !== artifact.size || hash.digest("base64") !== artifact.sha512) throw new Error("Update checksum mismatch");
    await rename(partial, target);
  } finally { await rm(partial, { force: true }); }
}
