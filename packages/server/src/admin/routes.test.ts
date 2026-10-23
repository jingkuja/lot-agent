import { describe, expect, it, vi } from "vitest";
import { adminApiKey, createAdminRoutes } from "./routes.js";

const KEY = "k".repeat(40);
function app() {
  const marketingMetrics = vi.fn(async (hours: number) => ({ window: { hours } }));
  const marketingReconciliation = vi.fn(async (hours: number) => ({ items: [], window: { hours } }));
  return { marketingMetrics, marketingReconciliation, routes: createAdminRoutes({ marketingMetrics, marketingReconciliation }, KEY) };
}

describe("admin API key", () => {
  it("is off when unset or too short", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(adminApiKey({})).toBeUndefined();
    expect(adminApiKey({ ADMIN_API_KEY: "  " })).toBeUndefined();
    expect(adminApiKey({ ADMIN_API_KEY: "short" })).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(adminApiKey({ ADMIN_API_KEY: ` ${KEY} ` })).toBe(KEY);
    warn.mockRestore();
  });

  it("requires the exact bearer key before reading metrics", async () => {
    const { routes, marketingMetrics, marketingReconciliation } = app();
    for (const authorization of [undefined, KEY, `Bearer ${KEY}x`, `Bearer ${KEY.slice(1)}`, "Bearer "]) {
      for (const path of ["/metrics/marketing", "/reconciliation/marketing"]) {
        const res = await routes.request(path, { headers: authorization ? { authorization } : {} });
        expect(res.status).toBe(401);
      }
    }
    expect(marketingMetrics).not.toHaveBeenCalled();
    expect(marketingReconciliation).not.toHaveBeenCalled();
    const res = await routes.request("/metrics/marketing", { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ window: { hours: 24 } });
  });

  it("bounds the window", async () => {
    const { routes, marketingMetrics } = app();
    const get = (hours: string) => routes.request(`/metrics/marketing?hours=${hours}`, { headers: { authorization: `Bearer ${KEY}` } });
    for (const hours of ["0", "721", "1.5", "abc"]) expect((await get(hours)).status).toBe(400);
    expect((await get("720")).status).toBe(200);
    expect(marketingMetrics).toHaveBeenCalledWith(720);
    const reconciliation = await routes.request("/reconciliation/marketing", { headers: { authorization: `Bearer ${KEY}` } });
    expect(await reconciliation.json()).toEqual({ items: [], window: { hours: 168 } });
  });
});
