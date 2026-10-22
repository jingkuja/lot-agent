import { describe, expect, it } from "vitest";
import { captionAss, captionLayout, captionLines, offsetCues, timeCaptions } from "./subtitles.js";

describe("caption lines", () => {
  it("splits the confirmed copy at punctuation and keeps its words", () => {
    expect(captionLines("欢迎光临！今天推荐招牌拿铁，只要¥19.9。", 14)).toEqual(["欢迎光临！", "今天推荐招牌拿铁", "只要¥19.9"]);
  });
  it("joins very short clauses and never splits numbers or Latin words", () => {
    expect(captionLines("好，很好。Price 1,999 today.", 14)).toEqual(["好，很好", "Price 1,999 today"]);
    const lines = captionLines("这款iPhone保护壳采用航空级铝合金材质轻薄耐摔还支持MagSafe磁吸充电", 14);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("这款iPhone保护壳采用航空级铝合金材质轻薄耐摔还支持MagSafe磁吸充电");
    expect(lines.some(line => line.includes("iPhone"))).toBe(true);
    expect(lines.some(line => line.includes("MagSafe"))).toBe(true);
  });
  it("keeps a closing quote with its clause", () => {
    expect(captionLines("她说：“真好喝。”我们下次再来", 14)).toEqual(["她说：“真好喝。”", "我们下次再来"]);
  });
});

describe("caption timing", () => {
  const lines = ["欢迎光临", "今天推荐招牌拿铁", "只要十九块九"];
  it("spreads lines over the spoken part of the take, in order and inside the shot", () => {
    const cues = timeCaptions(lines, 4, 6, [{ start: 0, end: 0.3 }, { start: 3.7, end: 4 }]);
    expect(cues[0].start).toBeCloseTo(0.2);
    expect(cues.at(-1)!.end).toBeCloseTo(4.2);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBe(cues[i - 1].end);
    expect(cues.every(cue => cue.end > cue.start)).toBe(true);
  });
  it("moves a line break to a nearby pause in the narration", () => {
    // Proportional breaks fall near 1.1s and 2.6s; the take pauses at 0.9–1.2s and 2.7–3.0s.
    const cues = timeCaptions(lines, 4, 6, [{ start: 0.9, end: 1.2 }, { start: 2.7, end: 3 }]);
    expect(cues.map(cue => cue.start)).toEqual([0, 1.2, 3]);
  });
  it("never runs past the end of the shot", () => {
    expect(timeCaptions(["一句话"], 4.8, 5).at(-1)!.end).toBeCloseTo(4.95);
  });
});

describe("caption offset", () => {
  const cues = [{ start: 0.2, end: 1.5, text: "一" }, { start: 1.5, end: 3, text: "二" }, { start: 3, end: 4.2, text: "三" }];
  it("moves every line by the offset and keeps the gaps between them", () => {
    offsetCues(cues, 0.4, 6).flatMap(cue => [cue.start, cue.end]).forEach((at, i) => expect(at).toBeCloseTo([0.6, 1.9, 1.9, 3.4, 3.4, 4.6][i]));
    expect(offsetCues(cues, 0, 6)).toBe(cues);
  });
  // The film's and the shot's offsets add up to at most two seconds.
  it("stops where the first or last line would be squeezed out of the shot", () => {
    const early = offsetCues(cues, -2, 6);
    expect(early[0].start).toBe(0);
    expect(early[0].end).toBeCloseTo(0.3);
    const late = offsetCues(cues, 2, 4.5);
    expect(late.at(-1)!.start).toBeCloseTo(4.15);
    expect(late.at(-1)!.end).toBeCloseTo(4.45);
    for (const moved of [early, late]) for (let i = 1; i < moved.length; i++) expect(moved[i].start).toBeCloseTo(moved[i - 1].end);
  });
});

describe("ASS script", () => {
  it("lays captions out for the frame and shows ASS control characters as text", () => {
    expect(captionLayout(720, 1280)).toEqual({ fontSize: 40, maxCells: 14, marginV: 205 });
    expect(captionLayout(720, 1280, { size: "large", position: "high" })).toEqual({ fontSize: 49, maxCells: 11, marginV: 307 });
    expect(captionLayout(1280, 720, { size: "small", position: "low" })).toEqual({ fontSize: 32, maxCells: 32, marginV: 36 });
    const ass = captionAss([{ start: 0, end: 61.234, text: "{\\b1}价格" }], 720, 1280);
    expect(ass).toContain("PlayResX: 720\nPlayResY: 1280");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:01:01.23,Default,,0,0,0,,｛＼b1｝价格");
  });
});
