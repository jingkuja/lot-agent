import { describe, expect, it } from "vitest";
import { marketingReferenceError, MarketingDraftSchema, planMarketingSegments, storyboardScript, resolveMarketingSegments, marketingReviewText, allocateShotDurations, timeMarketingStoryboard, isMarketingDurationValid } from "./index.js";

describe("marketing segment plan", () => {
  it.each([15, 17, 29, 30, 45, 59, 60])("preserves narration and respects the 15s cap for %ds", (duration) => {
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
    const edited = MarketingDraftSchema.parse({ ...draft, storyboard: shots.map((shot, i) => i ? shot : { ...shot, visual: "加入限时折扣招牌" }) });
    expect(marketingReviewText(edited)).not.toBe(marketingReviewText(draft));
  });
  it("rejects stale, incomplete and overlong boards without preventing partial draft saves", () => {
    const draft = MarketingDraftSchema.parse({ storyboard: shots, script: storyboardScript(shots) });
    expect(() => resolveMarketingSegments({ ...draft, durationSec: 60 })).toThrow("分镜总时长");
    expect(() => resolveMarketingSegments({ ...draft, script: "其他文案" })).toThrow("不一致");
    const partial = { ...draft, storyboard: shots.map(shot => ({ ...shot, camera: "" })) };
    expect(MarketingDraftSchema.safeParse(partial).success).toBe(true);
    expect(() => resolveMarketingSegments(MarketingDraftSchema.parse(partial))).toThrow("补全");
    const long = shots.map(shot => ({ ...shot, script: "字".repeat(100) }));
    expect(() => resolveMarketingSegments(MarketingDraftSchema.parse({ ...draft, storyboard: long, script: storyboardScript(long) }))).toThrow("过长");
  });
  it("keeps old drafts and their review keys compatible", () => {
    const draft = MarketingDraftSchema.parse({ script: "欢迎来到咖啡店，来这里喝一杯咖啡。" });
    expect(draft.storyboard).toEqual([]);
    expect(marketingReviewText(draft)).toBe([draft.script, draft.publishTitle, draft.tags].join("\n"));
    expect(resolveMarketingSegments(draft)).toEqual(planMarketingSegments(draft.script, 30));
  });
  it("keeps valid AI pacing and checks narration against each shot's duration", () => {
    const storyboard = shots.map((shot, i) => ({ ...shot, durationSec: i ? 11 : 6 }));
    const draft = MarketingDraftSchema.parse({ durationSec: 17, storyboard, script: storyboardScript(storyboard) });
    expect(resolveMarketingSegments(draft).map(p => p.durationSec)).toEqual([6, 11]);
    expect(timeMarketingStoryboard(draft.storyboard, 17)).toEqual(storyboard);
    const long = { ...storyboard[0], durationSec: 4, script: "字".repeat(19) };
    expect(() => resolveMarketingSegments({ ...draft, durationSec: 15, storyboard: [long, storyboard[1]], script: storyboardScript([long, storyboard[1]]) })).toThrow("过长");
    const legacy = MarketingDraftSchema.parse({ storyboard: shots, script: storyboardScript(shots) });
    expect(legacy.storyboard.map(s => s.durationSec)).toEqual([15, 15]);
  });
  it("preserves AI pacing within the extra five seconds, rejecting shorter or excessive totals", () => {
    for (const target of [15, 30, 45, 60]) {
      const count = Math.ceil((target + 5) / 15);
      for (let actual = target; actual <= target + 5; actual++) {
        const storyboard = Array.from({ length: count }, (_, i) => ({ ...shots[i % 2], durationSec: Math.floor(actual / count) + (i < actual % count ? 1 : 0) }));
        const draft = MarketingDraftSchema.parse({ durationSec: target, storyboard, script: storyboardScript(storyboard) });
        expect(timeMarketingStoryboard(storyboard, target)).toEqual(storyboard);
        expect(resolveMarketingSegments(draft).reduce((sum, s) => sum + s.durationSec, 0)).toBe(actual);
      }
      for (const actual of [target - 1, target + 6]) {
        const storyboard = Array.from({ length: count }, (_, i) => ({ ...shots[i % 2], durationSec: Math.floor(actual / count) + (i < actual % count ? 1 : 0) }));
        expect(() => resolveMarketingSegments(MarketingDraftSchema.parse({ durationSec: target, storyboard, script: storyboardScript(storyboard) }))).toThrow("分镜总时长");
      }
    }
    // Extra narration can use the tolerance without demanding a longer target.
    expect(allocateShotDurations(Array.from({ length: 5 }, () => ({ script: "字".repeat(58) })), 60)).toEqual([13, 13, 13, 13, 13]);
  });
  it("allocates totals within tolerance across the full range, with at most fifteen bounded shots", () => {
    for (let total = 15; total <= 60; total++) {
      expect(MarketingDraftSchema.safeParse({ durationSec: total }).success).toBe(true);
      for (let count = Math.ceil(total / 15); count <= Math.min(15, Math.floor((total + 5) / 4)); count++) {
        const shots = Array.from({ length: count }, (_, i) => ({ script: "欢迎光临。", durationSec: 4 + i % 12 }));
        const durations = allocateShotDurations(shots, total);
        expect(isMarketingDurationValid(total, durations.reduce((a, b) => a + b))).toBe(true);
        expect(durations.every(n => Number.isInteger(n) && n >= 4 && n <= 15)).toBe(true);
      }
    }
    for (const total of [14, 61, 15.5]) expect(MarketingDraftSchema.safeParse({ durationSec: total }).success).toBe(false);
    expect(() => allocateShotDurations([{ script: "字".repeat(68) }], 15)).toThrow("过长");
    expect(() => allocateShotDurations(Array.from({ length: 6 }, () => ({ script: "欢迎" })), 15)).toThrow("分镜数量");
  });
});

it("limits each image category to three UUIDs and accepts legacy single images", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const slot of ["portrait", "background", "scene"]) {
    for (const value of [id, [id], [id, id, id]]) expect(MarketingDraftSchema.safeParse({ assets: { [slot]: value } }).success).toBe(true);
    for (const value of [[], [id, id, id, id], ["https://untrusted.test/image.png"]]) expect(MarketingDraftSchema.safeParse({ assets: { [slot]: value } }).success).toBe(false);
  }
});

it("shares the three-image allowance across background and scene", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(MarketingDraftSchema.safeParse({ assets: { portrait: [id, id, id], background: id, scene: [id, id] } }).success).toBe(true);
  expect(MarketingDraftSchema.safeParse({ assets: { background: [id, id], scene: [id, id] } }).success).toBe(false);
});

it("allows draft editing but blocks video generation with more than three images", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(marketingReferenceError(MarketingDraftSchema.parse({ assets: { video: id, portrait: [id, id], scene: id } }))).toBe("");
  expect(marketingReferenceError(MarketingDraftSchema.parse({ assets: { video: id, portrait: [id, id], scene: [id, id] } }))).toContain("不能超过 3 张");
  expect(MarketingDraftSchema.safeParse({ assets: { video: [id, id] } }).success).toBe(false);
});
