import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { encryptPassword } from "./rsa.js";

describe("encryptPassword", () => {
  describe("Web Crypto path (crypto.subtle available)", () => {
    it("produces base64 RSA-OAEP ciphertext Node can decrypt", async () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const cipher = await encryptPassword(pem, "Aa147258@");
      const plain = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(cipher, "base64")
      ).toString("utf-8");
      expect(plain).toBe("Aa147258@");
    });
  });

  describe("node-forge fallback (crypto.subtle unavailable)", () => {
    let originalSubtle: SubtleCrypto | undefined;

    beforeEach(() => {
      originalSubtle = (globalThis.crypto as { subtle?: SubtleCrypto } | undefined)?.subtle;
      // Simulate non-secure HTTP context
      delete (globalThis as { crypto?: Crypto }).crypto;
    });

    afterEach(() => {
      if (originalSubtle !== undefined) {
        (globalThis as { crypto?: { subtle: SubtleCrypto } }).crypto = {
          subtle: originalSubtle,
          getRandomValues: () => new Uint8Array(),
        } as unknown as Crypto;
      }
    });

    it("produces base64 RSA-OAEP ciphertext Node can decrypt", async () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const cipher = await encryptPassword(pem, "Aa147258@");
      const plain = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(cipher, "base64")
      ).toString("utf-8");
      expect(plain).toBe("Aa147258@");
    });

    it("works with special characters in password", async () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const password = "中文 !@#$%^&*()_+-=[]{}|;:',.<>/?`~";
      const cipher = await encryptPassword(pem, password);
      const plain = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(cipher, "base64")
      ).toString("utf-8");
      expect(plain).toBe(password);
    });
  });
});
