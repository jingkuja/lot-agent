import { describe, it, expect } from "vitest";
import { publicEncrypt, constants } from "node:crypto";
import { generateRsaKeypair } from "./rsa.js";

describe("generateRsaKeypair", () => {
  it("round-trips a password encrypted with the public key (RSA-OAEP/SHA-256)", () => {
    const kp = generateRsaKeypair();
    const cipher = publicEncrypt(
      { key: kp.publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from("Aa147258@", "utf-8")
    ).toString("base64");
    expect(kp.decrypt(cipher)).toBe("Aa147258@");
  });

  it("exposes a PEM public key", () => {
    expect(generateRsaKeypair().publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
  });
});
