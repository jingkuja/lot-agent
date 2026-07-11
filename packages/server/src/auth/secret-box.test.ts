import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { SecretBox, createSecretBox, sha256Hex } from "./secret-box.js";

const HEX_KEY = randomBytes(32).toString("hex");

describe("SecretBox", () => {
  it("round-trips a plaintext through seal/open when a key is configured", () => {
    const box = new SecretBox(HEX_KEY);
    const sealed = box.seal("sk-super-secret");
    expect(sealed).not.toBe("sk-super-secret");
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(box.open(sealed)).toBe("sk-super-secret");
  });

  it("accepts a base64-encoded 32-byte key", () => {
    const b64Key = randomBytes(32).toString("base64");
    const box = new SecretBox(b64Key);
    const sealed = box.seal("hello");
    expect(box.open(sealed)).toBe("hello");
  });

  it("is a passthrough when no master key is provided (seal is a no-op)", () => {
    const box = new SecretBox(undefined);
    expect(box.enabled).toBe(false);
    expect(box.seal("plain-value")).toBe("plain-value");
  });

  it("passthrough open() returns legacy plaintext unchanged", () => {
    const box = new SecretBox(undefined);
    expect(box.open("some-legacy-plaintext-key")).toBe("some-legacy-plaintext-key");
  });

  it("open() returns legacy plaintext unchanged even when a key IS configured (back-compat)", () => {
    const box = new SecretBox(HEX_KEY);
    expect(box.open("legacy-plaintext-api-key")).toBe("legacy-plaintext-api-key");
  });

  it("reports enabled = true only when a key is configured", () => {
    expect(new SecretBox(HEX_KEY).enabled).toBe(true);
    expect(new SecretBox(undefined).enabled).toBe(false);
  });

  it("throws at construction time when the master key has the wrong length", () => {
    expect(() => new SecretBox("too-short")).toThrow();
    expect(() => new SecretBox(randomBytes(16).toString("hex"))).toThrow();
  });

  it("throws when opening a tampered ciphertext (GCM auth tag mismatch)", () => {
    const box = new SecretBox(HEX_KEY);
    const sealed = box.seal("sk-super-secret");
    const parts = sealed.split(":");
    // Flip the last character of the ciphertext segment.
    const ct = parts[4];
    const flipped = ct.slice(0, -1) + (ct.at(-1) === "A" ? "B" : "A");
    const tampered = [...parts.slice(0, 4), flipped].join(":");
    expect(() => box.open(tampered)).toThrow();
  });

  it("throws when opening an enc:-prefixed value with a malformed structure", () => {
    const box = new SecretBox(HEX_KEY);
    expect(() => box.open("enc:v1:not-enough-parts")).toThrow();
  });

  it("produces a different ciphertext each time (random iv) for the same plaintext", () => {
    const box = new SecretBox(HEX_KEY);
    const a = box.seal("same-plain-text");
    const b = box.seal("same-plain-text");
    expect(a).not.toBe(b);
    expect(box.open(a)).toBe("same-plain-text");
    expect(box.open(b)).toBe("same-plain-text");
  });

  describe("createSecretBox", () => {
    it("returns a passthrough box when SECRET_MASTER_KEY is unset", () => {
      const prev = process.env.SECRET_MASTER_KEY;
      delete process.env.SECRET_MASTER_KEY;
      try {
        const box = createSecretBox();
        expect(box.enabled).toBe(false);
      } finally {
        if (prev !== undefined) process.env.SECRET_MASTER_KEY = prev;
      }
    });

    it("returns an enabled box when SECRET_MASTER_KEY is set", () => {
      const prev = process.env.SECRET_MASTER_KEY;
      process.env.SECRET_MASTER_KEY = HEX_KEY;
      try {
        const box = createSecretBox();
        expect(box.enabled).toBe(true);
      } finally {
        if (prev !== undefined) process.env.SECRET_MASTER_KEY = prev;
        else delete process.env.SECRET_MASTER_KEY;
      }
    });
  });
});

describe("sha256Hex", () => {
  it("matches the known NIST test vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("matches the known vector for the empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("is deterministic for the same input", () => {
    expect(sha256Hex("token-abc")).toBe(sha256Hex("token-abc"));
  });

  it("differs for different inputs", () => {
    expect(sha256Hex("token-abc")).not.toBe(sha256Hex("token-abd"));
  });
});
