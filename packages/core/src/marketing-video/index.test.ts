import { describe, expect, it } from "vitest";
import { GROK_MARKETING_PROFILE, KLING_MARKETING_PROFILE, MARKETING_MAX_SECTION_IMAGES, marketingReferenceImageIssue, DEFAULT_MARKETING_VIDEO_MODEL, marketingJobProfile, marketingVideoProfile, capMarketingStoryboard, marketingShotMaxSeconds, marketingReferenceError, MarketingDraftSchema, planMarketingSegments, storyboardScript, resolveMarketingSegments, marketingReviewText, allocateShotDurations, timeMarketingStoryboard, isMarketingDurationValid, applyMarketingReviewSuggestion, updateMarketingReviewField, marketingReviewFieldText, marketingStoryboardAudioMismatch, marketingRevisionKey, marketingShotNeedsClip, marketingShotChanged, fitMarketingNarration, marketingNarrationFits, marketingVoiceover, marketingNativeSpeech, DEFAULT_MARKETING_VIDEO_PROFILE } from "./index.js";

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
  it("reviews the shared look only when present, keeping older review keys", () => {
    const draft = MarketingDraftSchema.parse({ storyboard: shots, script: storyboardScript(shots) });
    expect(draft.continuity).toBe("");
    expect(marketingReviewText(draft)).not.toContain("continuity");
    const styled = MarketingDraftSchema.parse({ ...draft, continuity: "米色针织衫，木质吧台" });
    expect(marketingReviewFieldText(styled, { field: "continuity" })).toBe("米色针织衫，木质吧台");
    expect(updateMarketingReviewField(styled, { field: "continuity" }, "灰色外套")?.continuity).toBe("灰色外套");
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

it("stores up to the largest model section per image slot and accepts legacy single images", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const many = (n: number) => Array.from({ length: n }, () => id);
  expect(MARKETING_MAX_SECTION_IMAGES).toBe(5);
  for (const slot of ["portrait", "product", "background", "scene"]) {
    for (const value of [id, [id], many(MARKETING_MAX_SECTION_IMAGES)]) expect(MarketingDraftSchema.safeParse({ assets: { [slot]: value } }).success).toBe(true);
    for (const value of [[], many(MARKETING_MAX_SECTION_IMAGES + 1), ["https://untrusted.test/image.png"]]) expect(MarketingDraftSchema.safeParse({ assets: { [slot]: value } }).success).toBe(false);
  }
});

it("applies each model's section and total image limits", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const many = (n: number) => Array.from({ length: n }, () => id);
  const error = (assets: object, profile = kling) => marketingReferenceError(MarketingDraftSchema.parse({ assets }), profile);
  // Kling: 3 per section, 7 in all; background and scene share a section.
  expect(error({ portrait: many(3), product: many(3), scene: id })).toBe("");
  expect(error({ background: many(2), scene: many(2) })).toContain("场景图片最多 3 张");
  expect(error({ product: many(4) })).toContain("产品图片最多 3 张");
  expect(error({ portrait: many(3), product: many(3), background: id, scene: id })).toContain("参考图片合计最多 7 张");
  // Grok: 4 people, 5 product, 5 setting, 14 in all.
  expect(error({ portrait: many(4), product: many(5), background: many(2), scene: many(3) }, grok)).toBe("");
  expect(error({ portrait: many(5) }, grok)).toContain("人物图片最多 4 张");
  expect(error({ background: many(3), scene: many(3) }, grok)).toContain("场景图片最多 5 张");
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
  expect(marketingReferenceError(MarketingDraftSchema.parse({ quality: "1080p", assets: { voice: id } }), grok)).toBe("");
});

it("keeps loading drafts saved with the removed cover slot and recorded mode", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const legacy = MarketingDraftSchema.parse({ mode: "recorded", assets: { cover: id, portrait: id } });
  expect(legacy.mode).toBe("avatar");
  expect(legacy.assets).toEqual({ portrait: id });
  // Re-parsing a parsed draft is stable, so frozen-draft comparisons still match.
  expect(MarketingDraftSchema.parse(legacy)).toEqual(legacy);
  expect(MarketingDraftSchema.safeParse({ assets: { cover: "https://evil.test/a.png", video: "https://evil.test/v.mp4" } }).success).toBe(false);
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

describe("reference image contract per model", () => {
  const image = { mime: "image/png", size: 1024, width: 800, height: 800 };
  it("applies Kling's documented format, edge and aspect limits", () => {
    expect(marketingReferenceImageIssue(KLING_MARKETING_PROFILE, image)).toBeUndefined();
    expect(marketingReferenceImageIssue(KLING_MARKETING_PROFILE, { ...image, mime: "image/webp" })).toBe("当前视频模型的参考图仅支持 JPG、PNG 格式");
    expect(marketingReferenceImageIssue(KLING_MARKETING_PROFILE, { ...image, width: 299 })).toBe("参考图宽高不能小于 300px");
    expect(marketingReferenceImageIssue(KLING_MARKETING_PROFILE, { ...image, width: 2001 })).toBe("参考图宽高比需在 1:2.5–2.5:1 之间");
  });
  it("accepts any decodable JPG/PNG/WebP for Grok, which documents no dimension limits", () => {
    expect(marketingReferenceImageIssue(GROK_MARKETING_PROFILE, { ...image, mime: "image/webp", width: 64, height: 4000 })).toBeUndefined();
    expect(marketingReferenceImageIssue(GROK_MARKETING_PROFILE, { ...image, mime: "image/gif" })).toBe("当前视频模型的参考图仅支持 JPG、PNG、WebP 格式");
    expect(marketingReferenceImageIssue(GROK_MARKETING_PROFILE, { ...image, width: 0 })).toBe("无法读取图片尺寸，请更换图片");
    expect(marketingReferenceImageIssue(GROK_MARKETING_PROFILE, { ...image, size: 21 * 1024 * 1024 })).toBe("参考图大小不能超过 20MB");
  });
});

describe("storyboard audio setting", () => {
  const video = "11111111-1111-4111-8111-111111111111";
  const storyboard = [{ durationSec: 15, script: "欢迎光临。", visual: "店内", action: "讲述", camera: "中景" }];
  it("flags a board planned for the other audio setting", () => {
    expect(marketingStoryboardAudioMismatch(MarketingDraftSchema.parse({ storyboard, storyboardAudio: true, assets: { video } }))).toBe(true);
    expect(marketingStoryboardAudioMismatch(MarketingDraftSchema.parse({ storyboard, storyboardAudio: false }))).toBe(true);
    expect(marketingStoryboardAudioMismatch(MarketingDraftSchema.parse({ storyboard, storyboardAudio: false, assets: { video } }))).toBe(false);
    expect(marketingStoryboardAudioMismatch(MarketingDraftSchema.parse({ storyboard, storyboardAudio: true }))).toBe(false);
  });
  it("does not flag older boards without a record or drafts without a board", () => {
    expect(marketingStoryboardAudioMismatch(MarketingDraftSchema.parse({ storyboard, assets: { video } }))).toBe(false);
    expect(marketingStoryboardAudioMismatch(MarketingDraftSchema.parse({ storyboardAudio: true, assets: { video } }))).toBe(false);
  });
});

describe("single shot redo", () => {
  const shots = [
    { durationSec: 8, script: "欢迎来到咖啡店。", visual: "人物在门口", action: "挥手", camera: "中景" },
    { durationSec: 8, script: "现磨咖啡很香。", visual: "人物端咖啡", action: "端起杯子", camera: "近景" },
  ];
  const draft = MarketingDraftSchema.parse({ durationSec: 15, storyboard: shots, script: storyboardScript(shots), publishTitle: "标题" });
  it("keeps settings, shot count and durations while shot text and publishing fields may change", () => {
    const edited = [shots[0], { ...shots[1], script: "咖啡现磨现做。", visual: "人物在吧台" }];
    expect(marketingRevisionKey({ ...draft, storyboard: edited, script: storyboardScript(edited), publishTitle: "新标题", tags: "#咖啡" })).toBe(marketingRevisionKey(draft));
    expect(marketingRevisionKey({ ...draft, storyboard: [shots[0], { ...shots[1], durationSec: 9 }] })).not.toBe(marketingRevisionKey(draft));
    expect(marketingRevisionKey({ ...draft, storyboard: [shots[0]] })).not.toBe(marketingRevisionKey(draft));
    expect(marketingRevisionKey({ ...draft, ratio: "16:9" })).not.toBe(marketingRevisionKey(draft));
    expect(marketingRevisionKey({ ...draft, continuity: "同一位店员" })).not.toBe(marketingRevisionKey(draft));
  });
  it("marks a shot changed by any of its text fields", () => {
    expect(marketingShotChanged(shots[0], { ...shots[0] })).toBe(false);
    for (const key of ["script", "visual", "action", "camera"] as const) expect(marketingShotChanged(shots[0], { ...shots[0], [key]: "改" })).toBe(true);
    expect(marketingShotChanged(shots[0], undefined)).toBe(true);
  });
  it("lets settings only the composition uses change, given the job's composition", () => {
    const music = "11111111-1111-4111-8111-111111111111";
    const plain = { narration: false, localSubtitles: false };
    const narrated = { narration: true, localSubtitles: true };
    const twin = MarketingDraftSchema.parse({ ...draft, narration: { speed: 1 }, subtitles: true });
    const key = (value: typeof draft, composition?: typeof plain) => marketingRevisionKey(value, composition);
    // Background music and its volume are mixed in locally for every job.
    expect(key({ ...draft, assets: { music }, musicVolume: 0.3 }, plain)).toBe(key(draft, plain));
    expect(key({ ...draft, assets: { music } })).not.toBe(key(draft));
    // Model-drawn captions are part of the clips; locally burned ones are not.
    expect(key({ ...draft, subtitles: !draft.subtitles }, plain)).not.toBe(key(draft, plain));
    expect(key({ ...twin, subtitles: false }, narrated)).toBe(key(twin, narrated));
    // A narrated job may change the twin voice, pace and tone, but not the voice mode.
    expect(key(MarketingDraftSchema.parse({ ...twin, narration: { speed: 1.2, instructions: "热情" } }), narrated)).toBe(key(twin, narrated));
    expect(key({ ...twin, narration: undefined }, narrated)).not.toBe(key(twin, narrated));
    expect(key({ ...draft, narration: MarketingDraftSchema.parse(twin).narration }, plain)).not.toBe(key(draft, plain));
    expect(key({ ...twin, ratio: "16:9" }, narrated)).not.toBe(key(twin, narrated));
  });
  it("keeps the picture of a narrated shot whose line alone changed", () => {
    const narrated = { narration: true, localSubtitles: true };
    expect(marketingShotNeedsClip(shots[0], { ...shots[0], script: "改" }, narrated)).toBe(false);
    expect(marketingShotNeedsClip(shots[0], { ...shots[0], script: "改" })).toBe(true);
    expect(marketingShotNeedsClip(shots[0], { ...shots[0], camera: "改" }, narrated)).toBe(true);
    expect(marketingShotNeedsClip(shots[0], undefined, narrated)).toBe(true);
  });
});

describe("fitting shots to twin narration", () => {
  const shots = ["第一句。", "第二句。", "第三句。"].map(script => ({ durationSec: 5, script, visual: "v", action: "a", camera: "c" }));
  const draft = MarketingDraftSchema.parse({ durationSec: 15 });
  it("lengthens only shots whose take does not fit, within the target range", () => {
    expect(marketingNarrationFits(4800, 5)).toBe(true);
    expect(marketingNarrationFits(4900, 5)).toBe(false);
    const fitted = fitMarketingNarration(shots, draft, DEFAULT_MARKETING_VIDEO_PROFILE, [3000, 6200, 2000]);
    expect(fitted.map(shot => shot.durationSec)[1]).toBeGreaterThanOrEqual(7);
    expect(fitted.every((shot, i) => marketingNarrationFits([3000, 6200, 2000][i], shot.durationSec))).toBe(true);
    const total = fitted.reduce((sum, shot) => sum + shot.durationSec, 0);
    expect(total).toBeGreaterThanOrEqual(15); expect(total).toBeLessThanOrEqual(20);
  });
  it("asks to shorten copy instead of exceeding the duration range or the shot cap", () => {
    expect(() => fitMarketingNarration(shots, draft, DEFAULT_MARKETING_VIDEO_PROFILE, [9000, 9000, 9000])).toThrow("配音总时长超过");
    expect(() => fitMarketingNarration(shots, draft, DEFAULT_MARKETING_VIDEO_PROFILE, [3000, 16_000, 2000])).toThrow("有分镜的配音超过");
  });
  it("only applies to drafts without a reference video", () => {
    const narrated = MarketingDraftSchema.parse({ narration: {} });
    expect(marketingVoiceover(narrated)).toBe(true); expect(marketingNativeSpeech(narrated)).toBe(false);
    const silent = MarketingDraftSchema.parse({ narration: {}, assets: { video: "11111111-1111-4111-8111-111111111111" } });
    expect(marketingVoiceover(silent)).toBe(false); expect(marketingNativeSpeech(silent)).toBe(false);
    expect(marketingNativeSpeech(MarketingDraftSchema.parse({}))).toBe(true);
  });
});
