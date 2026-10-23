import { describe, expect, it } from "vitest";
import { MARKETING_MATERIAL_RULES, MARKETING_MAX_SPEECH_PACE, MARKETING_SPEECH_PACE, marketingMaterialRule, marketingMegabytes, marketingSpeechMinimumSeconds,
  marketingSpeechSeconds, speechUnits } from "./index.js";

describe("material rules", () => {
  it("gives every image slot one rule and keeps the other slots apart", () => {
    for (const slot of ["portrait", "product", "background", "scene"]) expect(marketingMaterialRule(slot)).toBe(MARKETING_MATERIAL_RULES.image);
    expect(marketingMegabytes(marketingMaterialRule("video").maxBytes)).toBe(150);
    expect(marketingMegabytes(marketingMaterialRule("music").maxBytes)).toBe(30);
    expect(marketingMaterialRule("voice")).toMatchObject({ minSeconds: 2, maxSeconds: 15 });
    expect(marketingMaterialRule("music").formats).toContain("audio/x-wav");
  });
});

describe("speech pace", () => {
  it("estimates at the planning pace and allows lines up to the fastest one", () => {
    const line = "欢".repeat(45);
    expect(speechUnits(line)).toBe(45);
    expect(marketingSpeechSeconds(line)).toBe(Math.ceil(45 / MARKETING_SPEECH_PACE));
    expect(marketingSpeechMinimumSeconds(line)).toBe(Math.ceil(45 / MARKETING_MAX_SPEECH_PACE));
    expect(MARKETING_MAX_SPEECH_PACE).toBeGreaterThan(MARKETING_SPEECH_PACE);
  });
});
