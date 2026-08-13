/**
 * Token storage with two backends:
 *
 * - **Desktop (Electron)**: the `window.lotDesktop` bridge persists the token
 *   via the OS secure storage (Keychain / DPAPI). Reads are served from an
 *   in-memory cache seeded at startup so this module stays synchronous (the
 *   API client attaches the token on every request, including SSE).
 * - **Browser**: `localStorage`.
 *
 * All access is synchronous by design — keep it that way.
 */

const TOKEN_KEY = "lot_token";

/** `undefined` = not yet read from the backing store. */
let memoryToken: string | null | undefined;

function bridge() {
  return typeof window !== "undefined" ? window.lotDesktop : undefined;
}

function readInitial(): string | null {
  const b = bridge();
  if (b) return b.getToken();
  try {
    return typeof localStorage !== "undefined"
      ? localStorage.getItem(TOKEN_KEY)
      : null;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  if (memoryToken === undefined) memoryToken = readInitial();
  return memoryToken;
}

export function setToken(token: string): void {
  memoryToken = token;
  const b = bridge();
  if (b) {
    b.setToken(token);
    return;
  }
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage full / blocked — the in-memory copy still keeps the session alive
  }
}

export function clearToken(): void {
  memoryToken = null;
  const b = bridge();
  if (b) {
    b.setToken(null);
    return;
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

/** Test hook: drop the in-memory cache so the next read re-hits the store. */
export function __resetTokenStoreForTest(): void {
  memoryToken = undefined;
}
