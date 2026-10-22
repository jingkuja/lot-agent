import { describe, expect, it } from "vitest";
import { MarketingCaptionsSchema, MarketingDraftSchema, marketingCaptionErrors, marketingCaptionLines, marketingCaptionOffset, marketingCaptionSrt, marketingCaptionsValue, marketingFrameSize, marketingRevisionKey, type MarketingShot } from "./index.js";

const shots: MarketingShot[] = [
  { durationSec: 8, script: "欢迎光临！今天推荐招牌拿铁，只要¥19.9。", visual: "店内", action: "端起咖啡", camera: "中景" },
  { durationSec: 7, script: "下次再来。", visual: "门口", action: "挥手", camera: "远景" },
];
const draft = (captions?: unknown) => MarketingDraftSchema.parse({ durationSec: 15, storyboard: shots, script: shots.map(shot => shot.script).join("\n"), ...(captions ? { captions } : {}) });

describe("caption changes of a made video", () => {
  it("uses edited line breaks while the shot says the same words", () => {
    const edited = draft({ shots: [{ script: shots[0].script, lines: ["欢迎光临！今天推荐", "招牌拿铁，只要¥19.9"] }] });
    expect(marketingCaptionLines(edited, 0, shots[0].script, 14)).toEqual(["欢迎光临！今天推荐", "招牌拿铁，只要¥19.9"]);
    expect(marketingCaptionLines(edited, 1, shots[1].script, 14)).toEqual(["下次再来"]);
    expect(marketingCaptionErrors(edited)).toEqual([]);
    // A reworded shot falls back to the automatic split instead of showing stale lines.
    expect(marketingCaptionLines(edited, 0, "欢迎光临！", 14)).toEqual(["欢迎光临！"]);
  });
  it("never burns lines whose words differ from the shot", () => {
    const edited = draft({ shots: [{ script: shots[0].script, lines: ["欢迎光临", "今天推荐招牌美式"] }] });
    expect(marketingCaptionErrors(edited)).toEqual([0]);
    expect(marketingCaptionLines(edited, 0, shots[0].script, 14)).toEqual(["欢迎光临！", "今天推荐招牌拿铁", "只要¥19.9"]);
  });
  it("adds the film's offset to the shot's own", () => {
    const edited = draft({ offsetSec: -0.3, shots: [null, { script: shots[1].script, offsetSec: 0.1 }] });
    expect(marketingCaptionOffset(edited, 0, shots[0].script)).toBe(-0.3);
    expect(marketingCaptionOffset(edited, 1, shots[1].script)).toBe(-0.2);
    expect(marketingCaptionOffset(edited, 1, "改过的口播")).toBe(-0.3);
  });
  it("leaves unchanged captions out, so a reverted draft equals the made one", () => {
    expect(marketingCaptionsValue(MarketingCaptionsSchema.parse({ shots: [{ script: "x", offsetSec: 0 }, null] }))).toBeUndefined();
    expect(marketingCaptionsValue(MarketingCaptionsSchema.parse({ offsetSec: 0.1 + 0.2 }))).toMatchObject({ offsetSec: 0.3, shots: [] });
  });
  it("is a composition setting only for jobs whose captions are burned in locally", () => {
    const made = draft();
    const edited = draft({ size: "large", shots: [{ script: shots[0].script, offsetSec: 0.5 }] });
    expect(marketingRevisionKey(edited, { narration: false, localSubtitles: true })).toBe(marketingRevisionKey(made, { narration: false, localSubtitles: true }));
    expect(marketingRevisionKey(edited, { narration: false, localSubtitles: false })).not.toBe(marketingRevisionKey(made, { narration: false, localSubtitles: false }));
  });
  it("rejects offsets beyond one second", () => {
    expect(MarketingCaptionsSchema.safeParse({ offsetSec: 1.5 }).success).toBe(false);
  });
});

it("writes the burned captions as SRT", () => {
  expect(marketingCaptionSrt([{ shot: 0, start: 0.2, end: 1.5, text: "欢迎光临" }, { shot: 1, start: 61.25, end: 3725.004, text: "下次再来" }]))
    .toBe("1\n00:00:00,200 --> 00:00:01,500\n欢迎光临\n\n2\n00:01:01,250 --> 01:02:05,004\n下次再来\n");
});

it("composes at even frame sizes", () => {
  expect(marketingFrameSize({ quality: "720p", ratio: "9:16" })).toEqual({ width: 720, height: 1280 });
  expect(marketingFrameSize({ quality: "1080p", ratio: "16:9" })).toEqual({ width: 1920, height: 1080 });
});
