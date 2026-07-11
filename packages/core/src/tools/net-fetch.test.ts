import { describe, it, expect } from "vitest";
import { fetchPublicBinary } from "./net-fetch.js";
import { SsrfError } from "./net-guard.js";

type FakeHeaders = Record<string, string>;

function fakeResponse(opts: { status?: number; headers?: FakeHeaders; body?: ReadableStream<Uint8Array> }) {
  const status = opts.status ?? 200;
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body: opts.body,
  } as unknown as Response;
}

function streamOf(chunks: number[][]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(Uint8Array.from(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

const publicResolve = async (hostname: string) => {
  if (hostname === "internal.example") return [{ address: "127.0.0.1", family: 4 }];
  return [{ address: "93.184.216.34", family: 4 }];
};

describe("fetchPublicBinary", () => {
  it("rejects a private-resolving host with SsrfError", async () => {
    const fetchImpl = async () => {
      throw new Error("fetch should not be called when the SSRF guard rejects the host");
    };
    await expect(
      fetchPublicBinary("http://internal.example/file", {
        maxBytes: 1024,
        resolve: publicResolve,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(SsrfError);
  });

  it("rejects a redirect that lands on a private address", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) {
        return fakeResponse({ status: 302, headers: { location: "http://internal.example/evil" } });
      }
      throw new Error("should not fetch past the redirect that the guard must reject");
    };
    await expect(
      fetchPublicBinary("http://public.example/start", {
        maxBytes: 1024,
        resolve: publicResolve,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(SsrfError);
    expect(calls).toBe(1);
  });

  it("gives up after maxRedirects hops", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return fakeResponse({ status: 302, headers: { location: "http://public.example/next" } });
    };
    await expect(
      fetchPublicBinary("http://public.example/start", {
        maxBytes: 1024,
        maxRedirects: 2,
        resolve: publicResolve,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/redirect/i);
    expect(calls).toBe(3); // hop 0,1,2 — the 3rd redirect (hop === maxRedirects) is the one that fails
  });

  it("rejects immediately when Content-Length exceeds maxBytes, without reading the body", async () => {
    const fetchImpl = async () =>
      fakeResponse({ headers: { "content-type": "video/mp4", "content-length": "1000000" } });
    await expect(
      fetchPublicBinary("http://public.example/big.mp4", {
        maxBytes: 100,
        resolve: publicResolve,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow();
  });

  it("aborts mid-stream when there is no Content-Length but the body exceeds maxBytes", async () => {
    const fetchImpl = async () =>
      fakeResponse({
        headers: { "content-type": "application/octet-stream" },
        body: streamOf([[1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]]),
      });
    await expect(
      fetchPublicBinary("http://public.example/stream", {
        maxBytes: 10,
        resolve: publicResolve,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow();
  });

  it("returns the body and mime for a normal download", async () => {
    const fetchImpl = async () =>
      fakeResponse({
        headers: { "content-type": "image/png" },
        body: streamOf([[1, 2, 3], [4, 5, 6]]),
      });
    const result = await fetchPublicBinary("http://public.example/ok.png", {
      maxBytes: 1024,
      resolve: publicResolve,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.mime).toBe("image/png");
    expect(Buffer.from(result.body)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it("throws once the external abort signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      return fakeResponse({ headers: { "content-type": "image/png" }, body: streamOf([[1]]) });
    };
    await expect(
      fetchPublicBinary("http://public.example/ok.png", {
        maxBytes: 1024,
        resolve: publicResolve,
        signal: controller.signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow();
  });

  it("rejects non-http(s) protocols", async () => {
    const fetchImpl = async () => {
      throw new Error("fetch should not be called for a disallowed protocol");
    };
    await expect(
      fetchPublicBinary("ftp://public.example/file", {
        maxBytes: 1024,
        resolve: publicResolve,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow();
  });
});
