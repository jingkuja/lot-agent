import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, it, expect, vi } from "vitest";
import { fetchPublicBinary } from "./net-fetch.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:http", () => ({ request }));

function respond(bytes: Buffer, headers: Record<string, string>) {
  request.mockImplementation((_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      const incoming = Object.assign(Readable.from([bytes]), { statusCode: 200, headers });
      callback(incoming);
    };
    return req;
  });
}

describe("pinned HTTP transport", () => {
  it("uses the validated DNS result for the actual connection without resolving again", async () => {
    respond(Buffer.from("ok"), { "content-type": "text/plain" });
    const resolve = vi.fn().mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const result = await fetchPublicBinary("http://public.test/a", { resolve, maxBytes: 100 });
    const [url, options] = request.mock.calls.at(-1)!;
    expect(url.hostname).toBe("public.test");
    const callback = vi.fn();
    options.lookup("public.test", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.body.toString()).toBe("ok");
  });

  it("limits decompressed bytes as well as compressed payload size", async () => {
    const compressed = gzipSync(Buffer.from("x".repeat(5000)));
    respond(compressed, { "content-encoding": "gzip", "content-length": String(compressed.length) });
    await expect(fetchPublicBinary("http://public.test/a", {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }], maxBytes: 100,
    })).rejects.toThrow(/maxBytes/);
  });
});
