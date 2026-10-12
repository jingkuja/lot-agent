import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadArtifact, fetchManifest } from "./update-download.js";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "update-download-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });
const bytes = Buffer.from("verified installer");
const artifact = { file: "app.zip", size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") };
it("downloads with no credentials or redirects and reuses only verified caches", async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(bytes)); vi.stubGlobal("fetch", fetcher);
  const file = path.join(dir, "app.zip"), progress = vi.fn();
  await downloadArtifact(new URL("https://updates.example/"), artifact, file, new AbortController().signal, progress);
  expect(await readFile(file)).toEqual(bytes);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
  await downloadArtifact(new URL("https://updates.example/"), artifact, file, new AbortController().signal, progress);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await writeFile(file, "tampered");
  await downloadArtifact(new URL("https://updates.example/"), artifact, file, new AbortController().signal, progress);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([Buffer.from("bad"), Buffer.alloc(100), Buffer.alloc(bytes.length)])("never promotes a corrupt/incomplete/oversized download", async bad => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bad)));
  await expect(downloadArtifact(new URL("https://updates.example/"), artifact, path.join(dir, "app.zip"), new AbortController().signal, () => {})).rejects.toThrow();
  expect(await readdir(dir)).toEqual([]);
});
it("rejects missing feeds and oversized manifests", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
  await expect(fetchManifest(new URL("https://example.com/"), new AbortController().signal)).rejects.toThrow();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(130 * 1024))));
  await expect(fetchManifest(new URL("https://example.com/"), new AbortController().signal)).rejects.toThrow();
});
it("cancellation leaves no partial installer", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
  const controller = new AbortController(); controller.abort();
  await expect(downloadArtifact(new URL("https://updates.example/"), artifact, path.join(dir, "app.zip"), controller.signal, () => {})).rejects.toThrow();
  expect(await readdir(dir)).toEqual([]);
});
