import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { Readable, pipeline } from "node:stream";
import { createDeadline, withAbort } from "../runtime/abort.js";
import { resolvePublicUrl } from "./net-guard.js";
import type { ResolvedAddress } from "./net-guard.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REDIRECTS = 3;

export interface FetchPublicBinaryOptions {
  /** Hard cap on the downloaded body size, in bytes. Required — callers must
   * pick a limit appropriate to what they're downloading (e.g. image vs
   * video). */
  maxBytes: number;
  /** Overall time budget for the whole fetch (including redirects). Default 120s. */
  timeoutMs?: number;
  /** External cancellation, combined with the timeout into a single AbortController. */
  signal?: AbortSignal;
  /** Maximum number of redirect hops to follow before giving up. Default 3. */
  maxRedirects?: number;
  /** Hostnames allowed to resolve to a private address; forwarded to `assertPublicUrl`. */
  allowHosts?: string[];
  /** Test injection: DNS resolver used by the SSRF guard. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Test injection: fetch implementation. */
  fetchImpl?: typeof fetch;
}

/**
 * Downloads using validated, pinned addresses on every redirect hop, with
 * a hard byte cap and a deadline covering DNS, headers and the entire body. Reads
 * the response body as a stream so an oversized download is aborted as soon
 * as it crosses `maxBytes`, instead of being buffered whole first.
 */
export async function fetchPublicBinary(
  url: string,
  opts: FetchPublicBinaryOptions
): Promise<{ body: Buffer; mime: string }> {
  const {
    maxBytes,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: externalSignal,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    allowHosts,
    resolve,
    fetchImpl,
  } = opts;

  const deadline = createDeadline(timeoutMs, externalSignal);
  const signal = deadline.signal;
  try {
    let currentUrl = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`unsupported protocol: ${parsed.protocol}`);
      }
      signal.throwIfAborted();
      const addresses = await withAbort(resolvePublicUrl(currentUrl, { resolve, allowHosts }), signal);
      const res = await withAbort(fetchImpl
        ? fetchImpl(currentUrl, { redirect: "manual", signal })
        : fetchPinned(currentUrl, addresses, signal), signal);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        void res.body?.cancel().catch(() => {});
        if (hop === maxRedirects) {
          throw new Error(`too many redirects (>${maxRedirects})`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`download failed: HTTP ${res.status}`), { status: res.status, retryAfter: res.headers.get("retry-after") });
      }

      const mime = res.headers.get("content-type") ?? "application/octet-stream";
      const contentLength = res.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxBytes) {
        void res.body?.cancel().catch(() => {});
        throw new Error(`download exceeds maxBytes (${contentLength} > ${maxBytes})`);
      }

      const body = await readBodyWithLimit(res, maxBytes, signal);
      return { body, mime };
    }
    throw new Error("unreachable");
  } finally {
    deadline.dispose();
  }
}

/** Reads `res.body` incrementally, aborting as soon as the running total
 * exceeds `maxBytes` — never buffers the whole response via `arrayBuffer()`. */
async function readBodyWithLimit(res: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new Error(`download exceeds maxBytes (${maxBytes})`);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Connect only to a previously validated address. Host and TLS name stay original. */
function fetchPinned(url: string, addresses: ResolvedAddress[], signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(parsed, {
      signal,
      agent: false,
      headers: { "user-agent": "LotAgent/0.1", "accept-encoding": "identity" },
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    }, incoming => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const status = incoming.statusCode ?? 502;
      // Null-body HTTP statuses are rejected by the Response constructor.
      const empty = [204, 205, 304].includes(status);
      if (empty) incoming.resume();
      const encoding = incoming.headers["content-encoding"]?.toLowerCase();
      const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
        : encoding === "br" ? createBrotliDecompress() : undefined;
      if (decoder && !empty) pipeline(incoming, decoder, () => {});
      const source = decoder && !empty ? decoder : incoming;
      try {
        resolve(new Response(empty ? null : Readable.toWeb(source) as ReadableStream<Uint8Array>, { status, headers }));
      } catch (error) {
        source.destroy();
        incoming.destroy();
        reject(error);
      }
    });
    req.on("error", reject);
    req.end();
  });
}
