import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProductRoutes } from "./product.js";

beforeEach(() => vi.stubEnv("globle", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("public product links", () => {
  it("exposes only the configured public destinations", async () => {
    vi.stubEnv("LOT_AGENT_PUBLIC_URL", "https://claw.example.com/");
    vi.stubEnv("TOKENHUB_PUBLIC_URL", "https://hub.example.com/console");
    vi.stubEnv("NEW_API_INTERNAL_CLIENT_SECRET", "must-not-leak");
    const res = await createProductRoutes().request("/");
    expect(await res.json()).toEqual({ globle: 0, webUrl: "https://claw.example.com/", tokenhubUrl: "https://hub.example.com/console" });
  });

  it.each(["javascript:alert(1)", "https://secret:password@example.com", "broken", "https://example.com/?token=secret"])("rejects unsafe public configuration %s", async (value) => {
    vi.stubEnv("TOKENHUB_PUBLIC_URL", value);
    const res = await createProductRoutes().request("/");
    expect((await res.json() as { tokenhubUrl: string }).tokenhubUrl).toBe("https://tokenhub.todoucloud.com/");
  });
});


describe("international interface environment flag", () => {
  it.each([undefined, "", "0", "-1", "invalid", "Infinity", "NaN"])("keeps domestic mode for globle=%s", async (value) => {
    vi.stubEnv("globle", value);
    const res = await createProductRoutes().request("/");
    expect((await res.json() as { globle: number }).globle).toBe(0);
  });
  it.each(["1", "2", "0.5", " 3 "])("enables international mode for globle=%s", async (value) => {
    vi.stubEnv("globle", value);
    const res = await createProductRoutes().request("/");
    expect((await res.json() as { globle: number }).globle).toBe(1);
  });
});
