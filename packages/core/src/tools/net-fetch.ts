import { assertPublicUrl } from "./net-guard.js";
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
 * Downloads `url` into memory with the same SSRF posture as
 * `builtins.ts`'s `fetchPublic` (manual redirects, re-checked at every hop —
 * see the TOCTOU/DNS-rebinding caveat noted there, which applies here too),
 * plus a hard byte cap and a combined timeout/external-abort signal. Reads
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
    fetchImpl = fetch,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("download timed out")), timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onExternalAbort);
  }

  try {
    let currentUrl = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`unsupported protocol: ${parsed.protocol}`);
      }
      await assertPublicUrl(currentUrl, { resolve, allowHosts });

      const res = await fetchImpl(currentUrl, { redirect: "manual", signal: controller.signal });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === maxRedirects) {
          throw new Error(`too many redirects (>${maxRedirects})`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        throw new Error(`download failed: ${res.status}`);
      }

      const mime = res.headers.get("content-type") ?? "application/octet-stream";
      const contentLength = res.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxBytes) {
        throw new Error(`download exceeds maxBytes (${contentLength} > ${maxBytes})`);
      }

      const body = await readBodyWithLimit(res, maxBytes);
      return { body, mime };
    }
    throw new Error("unreachable");
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

/** Reads `res.body` incrementally, aborting as soon as the running total
 * exceeds `maxBytes` — never buffers the whole response via `arrayBuffer()`. */
async function readBodyWithLimit(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`download exceeds maxBytes (${maxBytes})`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
