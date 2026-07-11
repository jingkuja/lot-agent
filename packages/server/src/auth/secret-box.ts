import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const PREFIX = "enc:v1:";

/**
 * Envelope encryption for secrets-at-rest (tokenhub api keys, platform
 * access tokens). Backed by AES-256-GCM with a random 12-byte IV per call.
 *
 * With no master key configured, every method is a passthrough — this keeps
 * local/dev environments working unchanged and lets existing plaintext rows
 * keep working after upgrade (encryption is opt-in via SECRET_MASTER_KEY, but
 * once opted in, plaintext rows already in the DB are still read correctly
 * because `open()` only decrypts values carrying the `enc:v1:` prefix).
 */
export class SecretBox {
  readonly enabled: boolean;
  private readonly key: Buffer | null;

  constructor(masterKey?: string) {
    if (!masterKey) {
      this.key = null;
      this.enabled = false;
      return;
    }
    this.key = parseMasterKey(masterKey);
    this.enabled = true;
  }

  /** Encrypts `plain`; a no-op (returns `plain` unchanged) when no key is configured. */
  seal(plain: string): string {
    if (!this.enabled || !this.key) return plain;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
  }

  /**
   * Decrypts a value previously produced by `seal()`. Values that don't carry
   * the `enc:v1:` prefix are returned unchanged — this is what makes legacy
   * plaintext rows (written before SECRET_MASTER_KEY existed, or written
   * while it was unset) keep working with no migration/backfill needed.
   */
  open(stored: string): string {
    if (!stored.startsWith(PREFIX)) return stored;
    if (!this.enabled || !this.key) return stored;
    const rest = stored.slice(PREFIX.length);
    const parts = rest.split(":");
    if (parts.length !== 3) {
      throw new Error("secret_box_invalid_format");
    }
    const [ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ciphertext = Buffer.from(ctB64, "base64");
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  }
}

function parseMasterKey(masterKey: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(masterKey)
    ? Buffer.from(masterKey, "hex")
    : Buffer.from(masterKey, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SECRET_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}); ` +
        "generate one with `openssl rand -hex 32`"
    );
  }
  return key;
}

let warnedOnce = false;

/**
 * Builds a SecretBox from `process.env.SECRET_MASTER_KEY`. Missing env →
 * passthrough SecretBox + a one-time console warning (never a silent
 * downgrade of behavior that could surprise a caller expecting encryption —
 * the warning is the surfaced signal that secrets are being stored in
 * plaintext).
 */
export function createSecretBox(): SecretBox {
  const raw = process.env.SECRET_MASTER_KEY;
  if (!raw) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[secret-box] SECRET_MASTER_KEY is not set — api keys / access tokens will be stored in PLAINTEXT. " +
          "Set SECRET_MASTER_KEY (e.g. `openssl rand -hex 32`) in production."
      );
    }
    return new SecretBox(undefined);
  }
  return new SecretBox(raw);
}

/** Hex-encoded SHA-256 digest, used to store session tokens as a lookup key
 * without persisting the raw token (see `sessions.token_hash`). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
