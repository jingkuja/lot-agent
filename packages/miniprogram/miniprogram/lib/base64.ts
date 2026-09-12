const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += TABLE[a >> 2];
    out += TABLE[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? TABLE[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? TABLE[c & 63] : "=";
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  const len = clean.length;
  if (len % 4 !== 0) throw new Error("invalid base64");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((len / 4) * 3 - pad);
  let o = 0;
  const val = (ch: string): number => {
    const i = TABLE.indexOf(ch);
    if (i < 0) throw new Error("invalid base64");
    return i;
  };
  for (let i = 0; i < len; i += 4) {
    const n =
      (val(clean[i]) << 18) |
      (val(clean[i + 1]) << 12) |
      (clean[i + 2] === "=" ? 0 : val(clean[i + 2]) << 6) |
      (clean[i + 3] === "=" ? 0 : val(clean[i + 3]));
    out[o++] = (n >> 16) & 255;
    if (clean[i + 2] !== "=") out[o++] = (n >> 8) & 255;
    if (clean[i + 3] !== "=") out[o++] = n & 255;
  }
  return out;
}
