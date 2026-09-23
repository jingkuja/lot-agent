import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LocalStorage, type PrivateKnowledgeStorage, type PrivateKnowledgeObject } from "@lot-agent/core";
import { KnowledgeError } from "./errors.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEY = /^[a-f0-9-]{36}\/[a-f0-9]{64}$/;
const MB = 1024 * 1024;
export const KNOWLEDGE_MIME_LIMITS: Readonly<Record<string, number>> = {
  "text/plain": 50 * MB, "text/markdown": 50 * MB, "application/pdf": 50 * MB,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 50 * MB,
  "image/png": 20 * MB, "image/jpeg": 20 * MB, "image/gif": 20 * MB, "image/webp": 20 * MB,
  "audio/mpeg": 100 * MB, "audio/wav": 100 * MB, "audio/mp4": 100 * MB,
  "video/mp4": 200 * MB, "video/webm": 200 * MB,
};

function signatureMatches(mime: string, head: Buffer): boolean {
  const ascii = (start: number, end: number) => head.toString("ascii", start, end);
  if (mime.startsWith("text/")) return !head.includes(0);
  if (mime === "application/pdf") return ascii(0, 5) === "%PDF-";
  if (mime.endsWith("wordprocessingml.document")) return head.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]));
  if (mime === "image/png") return head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return head[0] === 255 && head[1] === 216 && head[2] === 255;
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  if (mime === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (mime === "audio/wav") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  if (mime === "audio/mpeg") return ascii(0, 3) === "ID3" || (head[0] === 255 && (head[1] & 224) === 224);
  if (mime === "video/mp4" || mime === "audio/mp4") return ascii(4, 8) === "ftyp";
  if (mime === "video/webm") return head.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  return false;
}

/** Immutable per-owner content-addressed blobs. Root is NEVER a static mount. */
export class LocalKnowledgeStorage implements PrivateKnowledgeStorage {
  constructor(private readonly root: string, private readonly maxBytes?: number) {}

  private path(key: string): string {
    if (!KEY.test(key) || !UUID.test(key.split("/")[0])) throw new KnowledgeError("INVALID_REQUEST", 400, "原件键无效");
    return resolve(this.root, key);
  }

  async put(ownerId: string, body: NodeJS.ReadableStream, mime: string): Promise<PrivateKnowledgeObject> {
    if (!UUID.test(ownerId)) throw new KnowledgeError("INVALID_REQUEST", 400, "资料归属无效");
    const cap = KNOWLEDGE_MIME_LIMITS[mime];
    if (!cap) throw new KnowledgeError("UNSUPPORTED_MEDIA", 415, "不支持的文件格式");
    const limit = Math.min(cap, this.maxBytes ?? cap);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(resolve(this.root, ".staging"), { recursive: true, mode: 0o700 });
    const stagingKey = `.staging/${randomUUID()}`;
    const stagingPath = resolve(this.root, stagingKey);
    const hash = createHash("sha256");
    let size = 0;
    let head = Buffer.alloc(0);
    const decoder = mime.startsWith("text/") ? new TextDecoder("utf-8", { fatal: true }) : null;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          size += chunk.length;
          if (size > limit) throw new KnowledgeError("PAYLOAD_TOO_LARGE", 413, "文件超过该类型的大小限制");
          if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
          if (decoder) {
            if (chunk.includes(0)) throw new Error("binary text");
            decoder.decode(chunk, { stream: true });
          }
          hash.update(chunk);
          callback(null, chunk);
        } catch (error) {
          callback(error instanceof KnowledgeError ? error : new KnowledgeError("UNSUPPORTED_MEDIA", 415, "文本必须为有效 UTF-8"));
        }
      },
    });
    try {
      // Reuse ObjectStorage's backpressure-aware writer, but never expose its URL.
      const target = new LocalStorage(this.root);
      const writes = await Promise.allSettled([
        pipeline(body, meter),
        target.putStream(stagingKey, meter, mime).catch((error) => { meter.destroy(error); throw error; }),
      ]);
      for (const write of writes) if (write.status === "rejected") throw write.reason;
      try { decoder?.decode(); } catch { throw new KnowledgeError("UNSUPPORTED_MEDIA", 415, "文本必须为有效 UTF-8"); }
      if (size === 0 || !signatureMatches(mime, head)) throw new KnowledgeError("UNSUPPORTED_MEDIA", 415, "文件内容与格式不匹配或为空");
      const sha256 = hash.digest("hex");
      const key = `${ownerId}/${sha256}`;
      await mkdir(resolve(this.root, ownerId), { recursive: true, mode: 0o700 });
      try { await link(stagingPath, this.path(key)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      return { key, sha256, size };
    } finally {
      await unlink(stagingPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  open(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.path(key), range);
  }

  async size(key: string): Promise<number> {
    return (await stat(this.path(key))).size;
  }
}
