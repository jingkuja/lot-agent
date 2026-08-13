/**
 * `crypto.randomUUID()` is only defined in a **secure context** (HTTPS or
 * localhost). The deployed box is frequently served over plain HTTP on a LAN IP,
 * where `crypto.randomUUID` is `undefined` — calling it throws and silently
 * breaks any handler that mints a temp client id (chat send, generation cards),
 * so the request is never even fired. Fall back to a `getRandomValues`-based
 * (or, last resort, `Math.random`) RFC-4122 v4 id. These ids are client-only
 * (optimistic message keys), so uniqueness matters, cryptographic strength does
 * not. Mirrors the `crypto.subtle` fallback already in `rsa.ts`.
 */
export function randomId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Set the RFC-4122 version (4) and variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
