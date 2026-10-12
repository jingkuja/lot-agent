import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, rm, readlink, readdir } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
// This is intentionally the same no-dependency script executed on the server.
// @ts-expect-error deployment script is JavaScript
import { prepare, publish } from "../../../deploy/desktop-release.mjs";
import { verifyManifest } from "../src/main/update-manifest.js";
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "desktop-publish-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = path.join(root, "private.pem"), pub = path.join(root, "public.pem");
  await writeFile(key, privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(pub, publicKey.export({ format: "pem", type: "spki" }));
  const input = path.join(root, "input"), output = path.join(root, "stage"), destination = path.join(root, "published");
  await mkdir(input);
  const file = "linquclaw-0.2.1-win-x64.exe";
  await writeFile(path.join(input, file), "installer");
  await prepare({ version: "0.2.1", platform: "win", arch: "x64", input, output, key });
  const source = path.join(output, "win-x64");
  return { source, destination, file, pub, args: { source, root: destination, "public-key": pub, "base-url": "https://updates.example/updates/stable/" } };
}
it("creates client-verifiable metadata and publishes pointer only after public verification", async () => {
  const f = await fixture();
  const envelope = await readFile(path.join(f.source, "latest.json"), "utf8");
  expect(verifyManifest(envelope, await readFile(f.pub, "utf8"), "win32", "x64").version).toBe("0.2.1");
  vi.stubGlobal("fetch", vi.fn(async () => {
    await expect(readFile(path.join(f.destination, "win-x64/latest.json"))).rejects.toThrow();
    return new Response(await readFile(path.join(f.destination, "win-x64", f.file)));
  }));
  await publish(f.args);
  expect(await readFile(path.join(f.destination, "win-x64/latest.json"), "utf8")).toBe(envelope);
  expect(await readlink(path.join(f.destination, "win-x64/download.exe"))).toBe(f.file);
  // Exact retries can repair an alias if the process stopped after pointer promotion.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("installer")));
  await publish(f.args);
  expect(await readlink(path.join(f.destination, "win-x64/download.exe"))).toBe(f.file);
});
it("does not expose a release when uploaded files are corrupt", async () => {
  const f = await fixture(); await writeFile(path.join(f.source, f.file), "bad");
  await expect(publish(f.args)).rejects.toThrow("checksum");
  expect(await readdir(path.join(f.destination, "win-x64"))).toEqual([]);
});
it("does not advance the pointer when public Nginx serves an error or SPA HTML", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>SPA</html>", { headers: { "content-type": "text/html", "content-length": "16" } })));
  const error = await publish(f.args).catch((error: Error) => error);
  expect(error.message).toContain("returned HTML instead of an installer");
  expect(error.message).toContain(`https://updates.example/updates/stable/win-x64/${f.file}`);
  expect(error.message).toContain("Content-Type: text/html");
  expect(error.message).toContain("Expected: 9 bytes");
  await expect(readFile(path.join(f.destination, "win-x64/latest.json"))).rejects.toThrow();
  expect(await readdir(path.join(f.destination, "win-x64"))).toEqual([f.file]);
});
it("reports same-size public corruption without advancing the release", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("corrupted")));
  const error = await publish(f.args).catch((error: Error) => error);
  expect(error.message).toContain("Public artifact checksum mismatch");
  expect(error.message).toContain("Received: 9 bytes");
  expect(error.message).toContain("Expected SHA-512:");
  expect(error.message).toContain("Received SHA-512:");
  await expect(readFile(path.join(f.destination, "win-x64/latest.json"))).rejects.toThrow();
});
it("refuses replacement of an already published versioned artifact", async () => {
  const f = await fixture(); await mkdir(path.join(f.destination, "win-x64"), { recursive: true });
  await writeFile(path.join(f.destination, "win-x64", f.file), "different release");
  await expect(publish(f.args)).rejects.toThrow("immutable");
});
