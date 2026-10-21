import { describe, expect, it } from "vitest";
import { estimateSpeechSec, planPresenterSegments, presenterMaterialBlocker, presenterTakesIssue, presenterTrackMs, PresenterDraftSchema, splitSentences } from "./index.js";

describe("digital presenter script", () => {
  it("splits Chinese and Latin sentences and keeps closing marks", () => {
    expect(splitSentences("大家好！今天介绍新品。\n价格很实惠？“欢迎来店。”Hello there. OK!")).toEqual(["大家好！", "今天介绍新品。", "价格很实惠？", "“欢迎来店。”", "Hello there.", "OK!"]);
    expect(splitSentences("版本 2.5 很好用。")).toEqual(["版本 2.5 很好用。"]);
    expect(splitSentences("。。")).toEqual([]);
  });
  it("estimates speech at the chosen pace", () => {
    expect(estimateSpeechSec("一二三四五六七八九十一二三四五六七八九十一")).toBeCloseTo(5);
    expect(estimateSpeechSec("one two three four five six seven eight nine ten eleven twelve thirteen", 1)).toBeCloseTo(5);
    expect(estimateSpeechSec("一二三四五六七八九十一二三四五六七八九十一", 1.25)).toBeCloseTo(4);
  });
  it("groups sentences into takes under the target length", () => {
    const sentence = "这是一句大约五秒钟长度的中文口播内容。"; // 18 characters ≈ 4.3 s
    const { segments, error } = planPresenterSegments(sentence.repeat(6));
    expect(error).toBeUndefined();
    expect(segments.map(s => s.text)).toEqual([sentence.repeat(2), sentence.repeat(2), sentence.repeat(2)]);
    expect(segments.every(s => s.estimateSec <= 12)).toBe(true);
    expect(segments.map(s => s.index)).toEqual([0, 1, 2]);
  });
  it("asks to split an overlong sentence and rejects empty or too many takes", () => {
    expect(planPresenterSegments("这".repeat(70) + "。").error).toBe("第 1 句过长，请用句号拆成更短的句子。");
    expect(planPresenterSegments("  ").error).toBe("请先填写口播文案。");
    expect(planPresenterSegments(("这是一句比较长的口播内容需要单独成段落来朗读完。").repeat(25)).error).toMatch(/最多分 12 段/);
  });
});

describe("digital presenter limits", () => {
  it("checks measured takes for each mode", () => {
    expect(presenterTrackMs([1000, 2000, 3000])).toBe(6500);
    expect(presenterTakesIssue("image", [10_000, 19_500])).toMatch(/第 2 段/);
    expect(presenterTakesIssue("image", [19_000, 19_000])).toBe("");
    expect(presenterTakesIssue("image", Array(6).fill(15_500))).toMatch(/90 秒/);
    expect(presenterTakesIssue("video", [1500])).toMatch(/超过 2 秒/);
    expect(presenterTakesIssue("video", Array(8).fill(15_000))).toMatch(/118 秒/);
    expect(presenterTakesIssue("video", Array(6).fill(19_000))).toBe("");
  });
  it("needs materials and consent before generating", () => {
    const draft = PresenterDraftSchema.parse({});
    expect(draft).toMatchObject({ mode: "image", ratio: "9:16", resolution: "720P", voice: { speed: 1, instructions: "" }, consent: false });
    expect(presenterMaterialBlocker(draft)).toMatch(/肖像/);
    expect(presenterMaterialBlocker({ ...draft, mode: "video" })).toMatch(/底片/);
    expect(presenterMaterialBlocker({ ...draft, portrait: "00000000-0000-4000-8000-000000000000" })).toMatch(/授权/);
    expect(presenterMaterialBlocker({ ...draft, portrait: "00000000-0000-4000-8000-000000000000", consent: true })).toBe("");
    expect(() => PresenterDraftSchema.parse({ unknown: 1 })).toThrow();
  });
});
