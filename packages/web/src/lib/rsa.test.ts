import { describe, it, expect } from "vitest";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { encryptPassword } from "./rsa.js";

describe("encryptPassword", () => {
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
