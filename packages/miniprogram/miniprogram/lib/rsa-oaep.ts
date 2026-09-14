import { decodeBase64, encodeBase64 } from "./base64";
import { sha256 } from "./sha256";
import { encodeUtf8 } from "./utf8";

const HASH_LEN = 32;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function mgf1(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  let counter = 0;
  while (offset < length) {
    const c = new Uint8Array(4);
    c[0] = (counter >>> 24) & 0xff;
    c[1] = (counter >>> 16) & 0xff;
    c[2] = (counter >>> 8) & 0xff;
    c[3] = counter & 0xff;
    const block = sha256(concatBytes(seed, c));
    const n = Math.min(HASH_LEN, length - offset);
    out.set(block.subarray(0, n), offset);
    offset += n;
    counter += 1;
  }
  return out;
}

class DerReader {
  constructor(private buf: Uint8Array, private i = 0) {}

  private byte(): number {
    if (this.i >= this.buf.length) throw new Error("truncated DER");
    return this.buf[this.i++];
  }

  private take(n: number): Uint8Array {
    if (this.i + n > this.buf.length) throw new Error("truncated DER");
    const slice = this.buf.subarray(this.i, this.i + n);
    this.i += n;
    return slice;
  }

  private len(): number {
    const first = this.byte();
    if (first < 0x80) return first;
    const count = first & 0x7f;
    let value = 0;
    for (let i = 0; i < count; i++) value = (value << 8) | this.byte();
    return value;
  }

  expect(tag: number): Uint8Array {
    if (this.byte() !== tag) throw new Error("unexpected DER tag");
    return this.take(this.len());
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
  let n = 0n;
  for (; i < bytes.length; i++) n = (n << 8n) + BigInt(bytes[i]);
  return n;
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = n;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error("integer too large");
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function parseSpkiPem(pem: string): { n: bigint; e: bigint; k: number } {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const der = decodeBase64(b64);
  const top = new DerReader(der);
  const seq = new DerReader(top.expect(0x30));
  seq.expect(0x30);
  const bitString = seq.expect(0x03);
  const keySeq = new DerReader(bitString.subarray(1));
  const key = new DerReader(keySeq.expect(0x30));
  const nBytes = key.expect(0x02);
  const eBytes = key.expect(0x02);
  const n = bytesToBigInt(nBytes);
  const e = bytesToBigInt(eBytes);
  const k = Math.ceil(n.toString(2).length / 8);
  return { n, e, k };
}

function oaepEncode(message: Uint8Array, k: number, seed: Uint8Array): Uint8Array {
  if (message.length > k - 2 * HASH_LEN - 2) throw new Error("message too long");
  const lHash = sha256(new Uint8Array(0));
  const ps = new Uint8Array(k - message.length - 2 * HASH_LEN - 2);
  const db = concatBytes(lHash, ps, new Uint8Array([0x01]), message);
  const dbMask = mgf1(seed, db.length);
  const maskedDB = xorBytes(db, dbMask);
  const seedMask = mgf1(maskedDB, HASH_LEN);
  const maskedSeed = xorBytes(seed, seedMask);
  return concatBytes(new Uint8Array([0x00]), maskedSeed, maskedDB);
}

async function randomBytes(length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  const webCrypto = (globalThis as unknown as {
    crypto?: { getRandomValues?: (bytes: Uint8Array) => Uint8Array };
  }).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(out);
    return out;
  }
  const wxRandom = typeof wx === "undefined" ? undefined : wx.getRandomValues;
  if (wxRandom) {
    return await new Promise((resolve, reject) => {
      wxRandom({
        length,
        success(res) {
          resolve(new Uint8Array(res.randomValues));
        },
        fail(err) {
          reject(new Error(err.errMsg || "random failed"));
        },
      });
    });
  }
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** RSA-OAEP/SHA-256 encrypt a password with an SPKI PEM public key. */
export async function encryptPassword(pemPublicKey: string, password: string): Promise<string> {
  const { n, e, k } = parseSpkiPem(pemPublicKey);
  const message = encodeUtf8(password);
  const seed = await randomBytes(HASH_LEN);
  const em = oaepEncode(message, k, seed);
  const m = bytesToBigInt(em);
  const c = modPow(m, e, n);
  return encodeBase64(bigIntToBytes(c, k));
}
