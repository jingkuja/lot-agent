import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { newerVersion, updateBase, verifyManifest } from "./update-manifest.js";
import { validateZipEntries } from "./mac-update.js";
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const artifact = (ext: string) => ({ file: `linquclaw-0.2.1-mac-arm64.${ext}`, size: 123, sha512: createHash("sha512").update("x").digest("base64") });
const manifest = () => ({ schema: 1, version: "0.2.1", platform: "darwin", arch: "arm64", notes: "改进 / Fixes", artifacts: { zip: artifact("zip"), dmg: artifact("dmg") } });
function signed(value: unknown) { const bytes = Buffer.from(JSON.stringify(value)); return JSON.stringify({ payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64") }); }
describe("signed update trust boundary", () => {
  it("accepts authenticated platform-specific releases", () => { expect(verifyManifest(signed(manifest()), publicKey, "darwin", "arm64").version).toBe("0.2.1"); });
  it("rejects tampering, another signer, wrong platform and wrong architecture", () => {
    const envelope = JSON.parse(signed(manifest()));
    envelope.payload = Buffer.from(JSON.stringify({ ...manifest(), version: "9.0.0" })).toString("base64");
    expect(() => verifyManifest(JSON.stringify(envelope), publicKey, "darwin", "arm64")).toThrow("signature");
    const wrong = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyManifest(signed(manifest()), wrong, "darwin", "arm64")).toThrow();
    expect(() => verifyManifest(signed(manifest()), publicKey, "win32", "arm64")).toThrow();
    expect(() => verifyManifest(signed(manifest()), publicKey, "darwin", "x64")).toThrow();
  });
  it.each(["../evil.zip", "https://evil.test/app.zip", "evil%2fapp.zip", "linquclaw-0.2.1-mac-arm64.zip?x=1"])("rejects artifact path %s", file => {
    const m = manifest(); m.artifacts.zip.file = file;
    expect(() => verifyManifest(signed(m), publicKey, "darwin", "arm64")).toThrow();
  });
  it("rejects excessive sizes and versions and requires a DMG fallback", () => {
    const m = manifest(); m.artifacts.zip.size = 2 ** 40;
    expect(() => verifyManifest(signed(m), publicKey, "darwin", "arm64")).toThrow();
    expect(() => verifyManifest(signed({ ...manifest(), version: "0.3.0-beta" }), publicKey, "darwin", "arm64")).toThrow();
    expect(() => verifyManifest(signed({ ...manifest(), artifacts: { zip: artifact("zip") } }), publicKey, "darwin", "arm64")).toThrow();
  });
  it("compares versions numerically and rejects downgrades", () => {
    expect(newerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(newerVersion("0.2.0", "0.2.0")).toBe(false);
    expect(newerVersion("0.1.0", "0.2.0")).toBe(false);
  });
  it("only permits pinned HTTPS feeds and supported targets", () => {
    expect(updateBase("https://updates.example/stable", "darwin", "x64").href).toBe("https://updates.example/stable/mac-x64/");
    for (const raw of ["http://example.com/", "https://user:pass@example.com/", "https://example.com/?token=x"]) expect(() => updateBase(raw, "darwin", "arm64")).toThrow();
    expect(() => updateBase("https://example.com/", "win32", "arm64")).toThrow();
  });
  it("rejects zip traversal, extra roots and empty archives", () => {
    validateZipEntries("Lot Agent.app/\nLot Agent.app/Contents/Info.plist\n");
    for (const value of ["", "../evil", "Lot Agent.app/../../evil", "/Lot Agent.app/file", "other.app/file", "Lot Agent.app/Contents\\evil"]) expect(() => validateZipEntries(value)).toThrow();
  });
});
