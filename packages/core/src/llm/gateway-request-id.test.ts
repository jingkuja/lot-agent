import { describe, expect, it, vi } from "vitest";
import { gatewayRequestId, withGatewayRequestId } from "./gateway-request-id.js";

describe("gateway request ID", () => {
  it("reads the New API log ID from fetch headers or SDK error headers", () => {
    expect(gatewayRequestId(new Headers({ "X-Oneapi-Request-Id": "20261021100000123abcDEF" }))).toBe("20261021100000123abcDEF");
    expect(gatewayRequestId({ "x-request-id": "req_123" })).toBe("req_123");
    expect(gatewayRequestId({ "x-oneapi-request-id": "bad id\nwith newline" })).toBeUndefined();
    expect(gatewayRequestId(undefined)).toBeUndefined();
  });
  it("reports the ID of a successful and of a failed request", async () => {
    const seen = vi.fn();
    const ok = Object.assign(Promise.resolve("stream"), { withResponse: async () => ({ data: "stream", response: new Response(null, { headers: { "x-oneapi-request-id": "ok-1" } }) }) });
    await expect(withGatewayRequestId(ok, seen)).resolves.toBe("stream");
    const error = Object.assign(new Error("503"), { headers: { "x-oneapi-request-id": "failed-1" } });
    const failed = Object.assign(Promise.reject(error), { withResponse: async () => { throw error; } });
    failed.catch(() => {});
    await expect(withGatewayRequestId(failed, seen)).rejects.toBe(error);
    expect(seen.mock.calls).toEqual([["ok-1"], ["failed-1"]]);
  });
});
