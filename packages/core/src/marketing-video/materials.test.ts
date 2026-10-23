import { describe, expect, it } from "vitest";
import { GROK_MARKETING_PROFILE, MARKETING_MATERIAL_RULES, MARKETING_MAX_SPEECH_PACE, MARKETING_SPEECH_PACE, MarketingDraftSchema, marketingFormatNames,
  marketingMaterialRule, marketingMegabytes, marketingMaxDuration, marketingSpeechEstimate, marketingSpeechMinimumSeconds, marketingSpeechSeconds,
  planMarketingSegments, resolveMarketingSegments, speechUnits, storyboardScript } from "./index.js";

describe("material rules", () => {
  it("gives every image slot one rule and keeps the other slots apart", () => {
    for (const slot of ["portrait", "product", "background", "scene"]) expect(marketingMaterialRule(slot)).toBe(MARKETING_MATERIAL_RULES.image);
    expect(marketingMegabytes(marketingMaterialRule("video").maxBytes)).toBe(150);
    expect(marketingMegabytes(marketingMaterialRule("music").maxBytes)).toBe(30);
    expect(marketingMaterialRule("voice")).toMatchObject({ minSeconds: 2, maxSeconds: 15 });
    expect(marketingMaterialRule("music").formats).toContain("audio/x-wav");
  });
  it("names formats as users know them", () => {
    expect(marketingFormatNames(MARKETING_MATERIAL_RULES.voice.formats)).toBe("MP3、WAV、M4A");
    expect(marketingFormatNames(MARKETING_MATERIAL_RULES.image.formats)).toBe("JPG、PNG、WebP");
    expect(marketingFormatNames(MARKETING_MATERIAL_RULES.video.formats)).toBe("MP4、MOV");
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
  it("shows accepted copy within the estimate and the capacity of the video (D07)", () => {
    // Two 15-second shots of 61 characters each pass the storyboard check at the fastest pace.
    const line = "欢".repeat(61), script = line + line;
    const shot = { script: line, visual: "吧台", action: "举杯", camera: "近景", durationSec: 15 };
    const storyboard = [shot, shot];
    const draft = MarketingDraftSchema.parse({ storyboard, script: storyboardScript(storyboard), durationSec: 30 });
    expect(resolveMarketingSegments(draft, GROK_MARKETING_PROFILE)).toHaveLength(2);
    expect(marketingSpeechEstimate(script)).toBe("28–31");
    expect(Number(marketingSpeechEstimate(script).split("–")[0])).toBeLessThanOrEqual(30);
    expect(Number(marketingSpeechEstimate(script).split("–")[1])).toBeLessThanOrEqual(marketingMaxDuration(30));
    expect(marketingSpeechEstimate("欢".repeat(8))).toBe("2");
  });
  it("refuses copy whose fastest estimate passes the longest allowed video", () => {
    expect(() => planMarketingSegments("欢".repeat(149), 30)).not.toThrow();
    const tooLong = "欢".repeat(158);
    expect(Number(marketingSpeechEstimate(tooLong).split("–")[0])).toBeGreaterThan(marketingMaxDuration(30));
    expect(() => planMarketingSegments(tooLong, 30)).toThrow("文案过长");
  });
});
