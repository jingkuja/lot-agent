import { it, expect, vi } from "vitest";
import { PreflightCache } from "./preflight-cache.js";
it("isolates credentials, coalesces requests, expires and never caches failures", async () => {
  const cache = new PreflightCache<number>(30); const load = vi.fn(async () => 7);
  expect(await Promise.all([cache.get("owner-key-a", load, 0), cache.get("owner-key-a", load, 1)])).toEqual([7,7]);
  expect(load).toHaveBeenCalledTimes(1);
  await cache.get("owner-key-b", load, 2); await cache.get("owner-key-a", load, 31); expect(load).toHaveBeenCalledTimes(3);
  await expect(cache.get("failure", async () => { throw new Error("unavailable"); }, 0)).rejects.toThrow();
  expect(await cache.get("failure", async () => 8, 1)).toBe(8);
});
