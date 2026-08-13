import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecureTokenStore, type TokenCipher } from "./secure-token.js";

// Fake cipher: reverse the bytes — deterministic and not plaintext, good
// enough to exercise the encrypt/decrypt plumbing.
const fakeCipher: TokenCipher = {
  encrypt: (plain) => Buffer.from(plain, "utf8").reverse(),
  decrypt: (encrypted) => Buffer.from(encrypted).reverse().toString("utf8"),
};

describe("SecureTokenStore", () => {
  let dir: string;
  let file: string;
  let store: SecureTokenStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lot-token-"));
    file = path.join(dir, "session-token");
    store = new SecureTokenStore(file, fakeCipher);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no token was stored", () => {
    expect(store.get()).toBeNull();
  });

  it("round-trips a token", () => {
    store.set("secret-token-123");
    expect(store.get()).toBe("secret-token-123");
  });

  it("does not store plaintext on disk", () => {
    store.set("secret-token-123");
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("secret-token-123");
  });

  it("writes the file with 0600 permissions", () => {
    store.set("abc");
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("clears the token with set(null)", () => {
    store.set("abc");
    store.set(null);
    expect(store.get()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("treats a corrupt file as logged out", () => {
    fs.writeFileSync(file, "!!! not base64 !!!");
    expect(store.get()).toBeNull();
  });
});
