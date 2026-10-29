import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayModelHeaders, internationalModelsEnabled } from "./model-access.js";

afterEach(() => vi.unstubAllEnvs());

describe("international model access", () => {
  it.each([undefined, "", "0", "-1", "invalid", "Infinity", "NaN"])("keeps domestic permissions for globle=%s", value => {
    vi.stubEnv("globle", value);
    expect(internationalModelsEnabled()).toBe(false);
    expect(gatewayModelHeaders()).toEqual({});
  });

  it.each(["1", "2", "0.5", " 3 "])("selects international additions for globle=%s", value => {
    vi.stubEnv("globle", value);
    expect(internationalModelsEnabled()).toBe(true);
    expect(gatewayModelHeaders()).toEqual({ "X-Agent-Globle": "1" });
  });
});
