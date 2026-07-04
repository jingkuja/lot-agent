import { generateKeyPairSync, privateDecrypt, constants, type KeyObject } from "node:crypto";

export interface RsaKeypair {
  publicKeyPem: string;
  decrypt(base64Ciphertext: string): string;
}

/** Ephemeral in-process RSA-OAEP/SHA-256 keypair. The public key is served to the
 * browser so it can encrypt the password before POSTing it; only this process can
 * decrypt. Regenerated each start — the browser always fetches a fresh key first. */
export function generateRsaKeypair(): RsaKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const priv: KeyObject = privateKey;
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    decrypt(base64Ciphertext: string): string {
      return privateDecrypt(
        { key: priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(base64Ciphertext, "base64")
      ).toString("utf-8");
    },
  };
}
