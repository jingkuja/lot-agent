/**
 * Encrypt a password with an SPKI-PEM RSA public key using RSA-OAEP/SHA-256.
 * Returns base64 ciphertext for POSTing to /api/auth/login.
 *
 * Uses browser-native crypto.subtle when available (secure contexts), falls
 * back to node-forge (pure JS) for non-secure HTTP contexts where
 * crypto.subtle is undefined.
 */
export async function encryptPassword(pemPublicKey: string, password: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    return encryptWithWebCrypto(pemPublicKey, password);
  }
  return encryptWithForge(pemPublicKey, password);
}

// ── Web Crypto path (secure contexts: HTTPS / localhost) ────────────────────

async function encryptWithWebCrypto(pemPublicKey: string, password: string): Promise<string> {
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

// ── Pure-JS fallback using node-forge (non-secure HTTP contexts) ────────────

async function encryptWithForge(pemPublicKey: string, password: string): Promise<string> {
  const forge = await import("node-forge");
  const publicKey = forge.pki.publicKeyFromPem(pemPublicKey);
  const utf8Bytes = forge.util.encodeUtf8(password);
  const encrypted = publicKey.encrypt(utf8Bytes, "RSA-OAEP", {
    md: forge.md.sha256.create(),
  });
  return forge.util.encode64(encrypted);
}

// ── PEM-to-DER helper ─────────────────────────────────────────────────────

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
