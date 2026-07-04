import { describe, it, expect } from "vitest";
import { THEME_PRESETS, getPreset, PRESET_LABELS } from "./themes.js";

describe("theme presets", () => {
  it("exposes 5 complete presets", () => {
    expect(Object.keys(THEME_PRESETS)).toHaveLength(5);
    for (const t of Object.values(THEME_PRESETS)) {
      expect(t.colors.accent1).toMatch(/^[0-9A-F]{6}$/);
      expect(t.colors.accent6).toMatch(/^[0-9A-F]{6}$/);
      expect(["circles", "slant", "grid", "minimal"]).toContain(t.decor);
    }
  });
  it("getPreset resolves by id, null on miss", () => {
    expect(getPreset("tech-dark")).toBe(THEME_PRESETS["tech-dark"]);
    expect(getPreset("nope")).toBeNull();
    expect(getPreset(undefined)).toBeNull();
  });
  it("PRESET_LABELS matches preset keys", () => {
    expect(PRESET_LABELS.map((p) => p.id).sort()).toEqual(Object.keys(THEME_PRESETS).sort());
  });
});
