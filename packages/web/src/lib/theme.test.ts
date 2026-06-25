import { describe, it, expect } from "vitest";
import { normalizeTheme, DEFAULT_THEME } from "./theme.js";

describe("normalizeTheme", () => {
  it("returns 'dark' for the dark value", () => {
    expect(normalizeTheme("dark")).toBe("dark");
  });

  it("returns 'light' for the light value", () => {
    expect(normalizeTheme("light")).toBe("light");
  });

  it("falls back to the default theme for null", () => {
    expect(normalizeTheme(null)).toBe(DEFAULT_THEME);
  });

  it("falls back to the default theme for an unknown value", () => {
    expect(normalizeTheme("solarized")).toBe(DEFAULT_THEME);
  });

  it("defaults to light", () => {
    expect(DEFAULT_THEME).toBe("light");
  });
});
