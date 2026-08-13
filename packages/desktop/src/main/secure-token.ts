import fs from "node:fs";
import path from "node:path";

/**
 * Pluggable cipher so the store stays testable without Electron. In the main
 * process this is backed by `safeStorage` (macOS Keychain / Windows DPAPI);
 * tests inject a fake.
 */
export interface TokenCipher {
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

/**
 * Persists the session token encrypted on disk (base64 of the cipher text,
 * file mode 0600). Reads are sync and cached by the renderer's token-store,
 * so this class deliberately stays sync too.
 */
export class SecureTokenStore {
  constructor(
    private readonly file: string,
    private readonly cipher: TokenCipher
  ) {}

  get(): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8").trim();
    } catch {
      return null;
    }
    // Reject anything that isn't well-formed base64 up front — a corrupt or
    // hand-edited file must read as "logged out", never reach the cipher.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
      return null;
    }
    try {
      return this.cipher.decrypt(Buffer.from(raw, "base64"));
    } catch {
      // Corrupt / wrong-machine file (DPAPI ties it to the OS user) — treat
      // as logged out rather than crashing.
      return null;
    }
  }

  set(token: string | null): void {
    if (token === null) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, this.cipher.encrypt(token).toString("base64"), {
      mode: 0o600,
    });
  }
}
