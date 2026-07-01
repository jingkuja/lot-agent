/** Encrypt a password with an SPKI-PEM RSA public key using RSA-OAEP/SHA-256.
 * Returns base64 ciphertext for POSTing to /api/auth/login. Browser-native
 * Web Crypto — no dependencies. */
export async function encryptPassword(pemPublicKey: string, password: string): Promise<string> {
  const der = pemToArrayBuffer(pemPublicKey);
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
  const cipher = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    new TextEncoder().encode(password)
  );
  return btoa(String.fromCharCode(...new Uint8Array(cipher)));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
