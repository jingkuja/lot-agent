import { describe, expect, it } from "vitest";
import { GROK_MARKETING_PROFILE, KLING_MARKETING_PROFILE, DEFAULT_MARKETING_VIDEO_MODEL, marketingJobProfile, marketingVideoProfile, capMarketingStoryboard, marketingShotMaxSeconds, marketingReferenceError, MarketingDraftSchema, planMarketingSegments, storyboardScript, resolveMarketingSegments, marketingReviewText, allocateShotDurations, timeMarketingStoryboard, isMarketingDurationValid, applyMarketingReviewSuggestion, updateMarketingReviewField, marketingReviewFieldText } from "./index.js";

const grok = GROK_MARKETING_PROFILE;
const kling = KLING_MARKETING_PROFILE;

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
    expect(resolveMarketingSegments(draft, grok).map(part => part.script)).toEqual(shots.map(shot => shot.script));
    const edited = MarketingDraftSchema.parse({ ...draft, storyboard: shots.map((shot, i) => i ? shot : { ...shot, visual: "加入限时折扣招牌" }) });
    expect(marketingReviewText(edited)).not.toBe(marketingReviewText(draft));
  });
  it("rejects stale, incomplete and overlong boards without preventing partial draft saves", () => {
    const draft = MarketingDraftSchema.parse({ storyboard: shots, script: storyboardScript(shots) });
    expect(() => resolveMarketingSegments({ ...draft, durationSec: 60 }, grok)).toThrow("分镜总时长");
    expect(() => resolveMarketingSegments({ ...draft, script: "其他文案" }, grok)).toThrow("不一致");
    const partial = { ...draft, storyboard: shots.map(shot => ({ ...shot, camera: "" })) };
    expect(MarketingDraftSchema.safeParse(partial).success).toBe(true);
    expect(() => resolveMarketingSegments(MarketingDraftSchema.parse(partial), grok)).toThrow("补全");
    const long = shots.map(shot => ({ ...shot, script: "字".repeat(100) }));
    expect(() => resolveMarketingSegments(MarketingDraftSchema.parse({ ...draft, storyboard: long, script: storyboardScript(long) }), grok)).toThrow("过长");
  });
  it("keeps old drafts readable but invalidates incomplete legacy review keys", () => {
    const draft = MarketingDraftSchema.parse({ script: "欢迎来到咖啡店，来这里喝一杯咖啡。" });
    expect(draft.storyboard).toEqual([]);
    expect(marketingReviewText(draft)).not.toBe([draft.script, draft.publishTitle, draft.tags].join("\n"));
    expect(marketingReviewText({ script: draft.script } as typeof draft)).toBe(marketingReviewText(draft));
    expect(resolveMarketingSegments(draft, grok)).toEqual(planMarketingSegments(draft.script, 30));
  });
  it("keeps valid AI pacing and checks narration against each shot's duration", () => {
    const storyboard = shots.map((shot, i) => ({ ...shot, durationSec: i ? 11 : 6 }));
    const draft = MarketingDraftSchema.parse({ durationSec: 17, storyboard, script: storyboardScript(storyboard) });
    expect(resolveMarketingSegments(draft, grok).map(p => p.durationSec)).toEqual([6, 11]);
    expect(timeMarketingStoryboard(draft.storyboard, 17)).toEqual(storyboard);
    const long = { ...storyboard[0], durationSec: 4, script: "字".repeat(19) };
    expect(() => resolveMarketingSegments({ ...draft, durationSec: 15, storyboard: [long, storyboard[1]], script: storyboardScript([long, storyboard[1]]) }, grok)).toThrow("过长");
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
        expect(resolveMarketingSegments(draft, grok).reduce((sum, s) => sum + s.durationSec, 0)).toBe(actual);
      }
      for (const actual of [target - 1, target + 6]) {
        const storyboard = Array.from({ length: count }, (_, i) => ({ ...shots[i % 2], durationSec: Math.floor(actual / count) + (i < actual % count ? 1 : 0) }));
        expect(() => resolveMarketingSegments(MarketingDraftSchema.parse({ durationSec: target, storyboard, script: storyboardScript(storyboard) }), grok)).toThrow("分镜总时长");
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

it("applies Kling's three-image reference video rule", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(marketingReferenceError(MarketingDraftSchema.parse({ assets: { video: id, portrait: [id, id], scene: id } }), kling)).toBe("");
  expect(marketingReferenceError(MarketingDraftSchema.parse({ assets: { video: id, portrait: [id, id], scene: [id, id] } }), kling)).toContain("不能超过 3 张");
  expect(MarketingDraftSchema.safeParse({ assets: { video: [id, id] } }).success).toBe(false);
});

it("uses a Grok reference video alone and caps references at 720p", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(DEFAULT_MARKETING_VIDEO_MODEL).toBe("grok-imagine-video-1.5");
  expect(marketingReferenceError(MarketingDraftSchema.parse({ assets: { video: id } }), grok)).toBe("");
  expect(marketingReferenceError(MarketingDraftSchema.parse({ assets: { video: id, portrait: id } }), grok)).toContain("不会参与生成");
  expect(marketingReferenceError(MarketingDraftSchema.parse({ quality: "1080p", assets: { scene: id } }), grok)).toContain("720p");
  expect(marketingReferenceError(MarketingDraftSchema.parse({ quality: "1080p", assets: { video: id } }), grok)).toContain("720p");
  expect(marketingReferenceError(MarketingDraftSchema.parse({ quality: "1080p", assets: { cover: id, voice: id } }), grok)).toBe("");
});

describe("located marketing review edits", () => {
  const storyboard = [
    { script: "这个产品最好。", visual: "产品最好海报", action: "介绍产品", camera: "近景" },
    { script: "欢迎了解信息。", visual: "另一张产品最好海报", action: "展示外观", camera: "中景" },
  ];
  const draft = MarketingDraftSchema.parse({ script: storyboardScript(storyboard), storyboard });
  const issue = { text: "最好", reason: "夸大", suggestion: "有特色", field: "storyboard.visual" as const, shotIndex: 0 };
  it("modifies only the exact declared field and supports deleting an excerpt", () => {
    const next = applyMarketingReviewSuggestion(draft, issue)!;
    expect(next.storyboard[0].visual).toBe("产品有特色海报");
    expect(next.storyboard[1]).toEqual(draft.storyboard[1]);
    expect(next.script).toBe(draft.script);
    expect(applyMarketingReviewSuggestion(draft, { ...issue, suggestion: "" })?.storyboard[0].visual).toBe("产品海报");
    expect(marketingReviewFieldText(draft, { field: "script", shotIndex: 0 })).toBeNull();
  });
  it("rejects ambiguous, absent, cross-shot and oversized replacements", () => {
    expect(applyMarketingReviewSuggestion({ ...draft, storyboard: [{ ...draft.storyboard[0], visual: "最好最好" }] }, issue)).toBeNull();
    expect(applyMarketingReviewSuggestion(draft, { ...issue, text: "没有这句话" })).toBeNull();
    expect(applyMarketingReviewSuggestion(draft, { ...issue, suggestion: "字".repeat(601) })).toBeNull();
    expect(applyMarketingReviewSuggestion(draft, { text: draft.script, suggestion: "新的口播。", reason: "风险", field: "script" })).toBeNull();
    expect(applyMarketingReviewSuggestion(draft, { ...issue, field: undefined })).toBeNull();
  });
  it("synchronizes both narration edit paths without changing other shots", () => {
    for (const location of [{ field: "script" as const }, { field: "storyboard.script" as const, shotIndex: 0 }]) {
      const next = applyMarketingReviewSuggestion(draft, { ...issue, ...location, shotIndex: "shotIndex" in location ? location.shotIndex : undefined })!;
      expect(next.script).toBe("这个产品有特色。\n欢迎了解信息。");
      expect(next.storyboard[0].script).toBe("这个产品有特色。");
      expect(next.storyboard[1]).toEqual(draft.storyboard[1]);
    }
    expect(applyMarketingReviewSuggestion({ ...draft, script: "不同的最好文案。" }, { ...issue, field: "script", shotIndex: undefined })).toBeNull();
    const manual = updateMarketingReviewField(draft, { field: "script" }, "完全重写的口播。")!;
    expect(manual.storyboard).toEqual([]);
    expect(manual.script).toBe("完全重写的口播。");
    expect(updateMarketingReviewField(draft, { field: "storyboard.script", shotIndex: 1 }, "手动修改。")?.script).toBe("这个产品最好。\n手动修改。");
  });
  it("invalidates checks after changes to every content field and its boundary", () => {
    const key = marketingReviewText(draft);
    for (const field of ["script", "publishTitle", "tags", "background"] as const)
      expect(marketingReviewText({ ...draft, [field]: draft[field] + "新内容" })).not.toBe(key);
    for (const field of ["script", "visual", "action", "camera"] as const)
      expect(marketingReviewText({ ...draft, storyboard: draft.storyboard.map((shot, i) => i ? shot : { ...shot, [field]: shot[field] + "新内容" }) })).not.toBe(key);
    expect(marketingReviewText({ ...draft, publishTitle: "a\nb", tags: "c" })).not.toBe(marketingReviewText({ ...draft, publishTitle: "a", tags: "b\nc" }));
  });
});

it("limits Grok reference video shots to 8 seconds", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const video = MarketingDraftSchema.parse({ assets: { video: id } });
  expect(marketingShotMaxSeconds(video, grok)).toBe(8);
  expect(marketingShotMaxSeconds(video, kling)).toBe(15);
  expect(marketingShotMaxSeconds(MarketingDraftSchema.parse({}), grok)).toBe(15);
  const script = "欢迎来到我们的店铺，".repeat(12);
  const parts = planMarketingSegments(script, 60, 8);
  expect(parts.length).toBeGreaterThanOrEqual(8);
  expect(parts.every(part => part.durationSec >= 4 && part.durationSec <= 8)).toBe(true);
  const shots = [0, 1, 2, 3].map(() => ({ durationSec: 15, script: "欢迎到店。", visual: "店内", action: "展示", camera: "中景" }));
  expect(() => resolveMarketingSegments({ ...video, durationSec: 60, script: storyboardScript(shots), storyboard: shots }, grok)).toThrow("每镜最长 8 秒");
  expect(resolveMarketingSegments({ ...video, durationSec: 60, script: storyboardScript(shots), storyboard: shots }, kling)).toHaveLength(4);
  expect(capMarketingStoryboard(shots, { ...video, durationSec: 30 }, grok).every(shot => shot.durationSec <= 8)).toBe(true);
  expect(capMarketingStoryboard(shots, MarketingDraftSchema.parse({ durationSec: 60 }), grok)).toBe(shots);
  expect(() => capMarketingStoryboard(shots.slice(0, 2), { ...video, durationSec: 30 }, grok)).toThrow("重新生成全部分镜");
  const retimed = timeMarketingStoryboard(shots, 30, 8);
  expect(retimed.every(shot => shot.durationSec <= 8)).toBe(true);
  expect(retimed.reduce((sum, shot) => sum + shot.durationSec, 0)).toBe(30);
  expect(resolveMarketingSegments({ ...video, durationSec: 30, script: storyboardScript(retimed), storyboard: retimed }, grok)).toHaveLength(4);
  expect(() => timeMarketingStoryboard(shots.slice(0, 2), 30, 8)).toThrow("分镜数量");
});

it("resolves model profiles for new and frozen jobs", () => {
  expect(marketingVideoProfile("kling-video-v3-omni")).toBe(kling);
  expect(marketingVideoProfile("unknown")).toBeUndefined();
  expect(marketingJobProfile({ modelId: "grok-imagine-video-1.5" })).toBe(grok);
  expect(marketingJobProfile({})).toBe(kling);
  expect(() => marketingJobProfile({ modelId: "retired-model" })).toThrow("不受支持");
});
