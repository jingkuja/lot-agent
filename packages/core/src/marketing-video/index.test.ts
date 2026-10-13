import { describe, expect, it } from "vitest";
import { MarketingDraftSchema, planMarketingSegments, storyboardScript, resolveMarketingSegments, marketingReviewText } from "./index.js";

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

describe("editable marketing storyboard", () => {
  const shots = [
    { script: "先看这杯手冲咖啡。", visual: "木质吧台上摆放咖啡", action: "抬起杯子", camera: "近景缓慢推进" },
    { script: "欢迎来店里坐一坐。", visual: "明亮的座位区", action: "向观众招手", camera: "中景固定镜头" },
  ];
  it("preserves manual boundaries and invalidates review after visual edits", () => {
    const draft = MarketingDraftSchema.parse({ storyboard: shots, script: storyboardScript(shots) });
    expect(resolveMarketingSegments(draft).map(part => part.script)).toEqual(shots.map(shot => shot.script));
    const edited = { ...draft, storyboard: shots.map((shot, i) => i ? shot : { ...shot, visual: "加入限时折扣招牌" }) };
    expect(marketingReviewText(edited)).not.toBe(marketingReviewText(draft));
  });
  it("rejects stale, incomplete and overlong boards without preventing partial draft saves", () => {
    const draft = MarketingDraftSchema.parse({ storyboard: shots, script: storyboardScript(shots) });
    expect(() => resolveMarketingSegments({ ...draft, durationSec: 60 })).toThrow("分镜数量");
    expect(() => resolveMarketingSegments({ ...draft, script: "其他文案" })).toThrow("不一致");
    const partial = { ...draft, storyboard: shots.map(shot => ({ ...shot, camera: "" })) };
    expect(MarketingDraftSchema.safeParse(partial).success).toBe(true);
    expect(() => resolveMarketingSegments(partial)).toThrow("补全");
    const long = shots.map(shot => ({ ...shot, script: "字".repeat(100) }));
    expect(() => resolveMarketingSegments({ ...draft, storyboard: long, script: storyboardScript(long) })).toThrow("过长");
  });
  it("keeps old drafts and their review keys compatible", () => {
    const draft = MarketingDraftSchema.parse({ script: "欢迎来到咖啡店，来这里喝一杯咖啡。" });
    expect(draft.storyboard).toEqual([]);
    expect(marketingReviewText(draft)).toBe([draft.script, draft.publishTitle, draft.tags].join("\n"));
    expect(resolveMarketingSegments(draft)).toEqual(planMarketingSegments(draft.script, 30));
  });
});
