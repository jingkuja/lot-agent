import { describe, expect, it } from "vitest";
import { MarketingDraftSchema, planMarketingSegments } from "./index.js";

describe("marketing segment plan", () => {
  it.each([30, 45, 60])("preserves narration and respects the 15s cap for %ds", (duration) => {
    const script = "欢迎来到我们的咖啡店。这里有现磨咖啡，也有舒适的座位。无论工作还是休息，都可以来坐一坐。期待与你见面。";
    const parts = planMarketingSegments(script, duration);
    expect(parts.map((p) => p.script).join("")).toBe(script);
    expect(parts.reduce((n, p) => n + p.durationSec, 0)).toBe(duration);
    expect(parts.every((p) => p.durationSec >= 4 && p.durationSec <= 15)).toBe(true);
  });
  it("preserves English word separators", () => {
    const text = "Visit our store today. Browse our latest collection and find something you love. We look forward to welcoming you.";
    expect(planMarketingSegments(text, 30).map(p => p.script).join("")).toBe(text);
  });
  it("rejects impossible narration and untrusted configuration", () => {
    expect(() => planMarketingSegments("长".repeat(300), 30)).toThrow("过长");
    expect(() => planMarketingSegments("", 30)).toThrow();
    expect(() => planMarketingSegments("。！？…", 30)).toThrow("过短");
    expect(() => planMarketingSegments("短片", 90)).toThrow();
    expect(MarketingDraftSchema.safeParse({ assets: { video: "https://evil.test/video" } }).success).toBe(false);
    expect(MarketingDraftSchema.safeParse({ userId: "other" }).success).toBe(false);
  });
});
