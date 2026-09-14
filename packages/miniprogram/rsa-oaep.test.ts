import { describe, expect, it } from "vitest";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { encryptPassword } from "./miniprogram/lib/rsa-oaep";
import { sha256 } from "./miniprogram/lib/sha256";
import { encodeBase64 } from "./miniprogram/lib/base64";
import { encodeUtf8 } from "./miniprogram/lib/utf8";

function bytesOf(text: string): number[] {
  return Array.from(encodeUtf8(text));
}

describe("miniprogram utf8", () => {
  it("matches TextEncoder for ascii, chinese, and emoji", () => {
    const samples = ["abc", "Aa147258@", "印社", "password密码🔐"];
    for (const sample of samples) {
      expect(bytesOf(sample)).toEqual(Array.from(new TextEncoder().encode(sample)));
    }
  });
});

describe("miniprogram sha256", () => {
  it("matches the SHA-256 of 'abc'", () => {
    const digest = sha256(encodeUtf8("abc"));
    expect(Buffer.from(digest).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(encodeBase64(digest).length).toBeGreaterThan(0);
  });
});

describe("miniprogram RSA-OAEP", () => {
  it("round-trips a password Node can decrypt with RSA-OAEP/SHA-256", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const cipher = await encryptPassword(pem, "Aa147258@");
    const plain = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(cipher, "base64")
    );
    expect(plain.toString("utf8")).toBe("Aa147258@");
  });

  it("round-trips a unicode password", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const password = "印社密码🔐";
    const cipher = await encryptPassword(pem, password);
    const plain = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(cipher, "base64")
    );
    expect(plain.toString("utf8")).toBe(password);
  });
});
