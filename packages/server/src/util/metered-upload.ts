import { createHash } from "node:crypto";
import { Readable } from "node:stream";

export class UploadTooLargeError extends Error {
  constructor() { super("upload too large"); this.name = "UploadTooLargeError"; }
}

/** A request body as a Node stream that is counted, capped at `maxBytes` and hashed as it
 * passes, so an upload goes to disk without being held in memory. `state` is complete once
 * the stream has ended; `head` keeps the first bytes for a file signature check. */
export function meteredUpload(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maxBytes: number) {
  const state = { size: 0, head: Buffer.alloc(0), sha256: "" };
  const hash = createHash("sha256");
  async function* pass() {
    for await (const chunk of body) {
      state.size += chunk.byteLength;
      if (state.size > maxBytes) throw new UploadTooLargeError();
      if (state.head.length < 16) state.head = Buffer.concat([state.head, Buffer.from(chunk.subarray(0, 16 - state.head.length))]);
      hash.update(chunk);
      yield chunk;
    }
    state.sha256 = hash.digest("hex");
  }
  return { stream: Readable.from(pass()), state };
}

/** The file name a raw upload sends in `X-File-Name` (URI-encoded, so any script survives the header). */
export function uploadFileName(header: string | undefined) {
  try { return decodeURIComponent(header ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255); }
  catch { return ""; }
}
