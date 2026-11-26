import { describe, expect, it } from "vitest";
import { COMIC_SCRIPT_MAX_CHARS, comicDirectorBreakdownSchema, isComicClipDraftBlank } from "./director.js";
import { parseComicDramaMasterScript, resolveComicEpisodeMasterScript } from "./master-script.js";

describe("parseComicDramaMasterScript & resolveComicEpisodeMasterScript", () => {
  it("parses the bracketed screenshot format while ignoring timestamp sub-headings", () => {
    const script = [
      "序言：全剧背景介绍，不作为分集。",
      "",
      "【第 1 集：雨夜里的过期快乐】",
      "",
      "【00:00-00:06 | 写字楼·深夜】",
      "冷白灯下，丽丽独自敲键盘。",
      "",
      "【00:06-00:13 | 街道→便利店门口】",
      "暴雨砸在深圳霓虹里。",
      "",
      "【第 2 集：热咖啡】",
      "【00:00-00:08 | 便利店收银台】",
      "小田递出一杯热拿铁。",
    ].join("\n");

    const parsed = parseComicDramaMasterScript(script);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      episodeNo: 1,
      title: "雨夜里的过期快乐",
      heading: "【第 1 集：雨夜里的过期快乐】",
      truncated: false,
    });
    expect(parsed[0]!.content).toContain("【00:00-00:06 | 写字楼·深夜】");
    expect(parsed[0]!.content).not.toContain("【第 2 集：热咖啡】");
    expect(parsed[0]!.content).not.toContain("序言");

    expect(parsed[1]).toMatchObject({
      episodeNo: 2,
      title: "热咖啡",
      heading: "【第 2 集：热咖啡】",
      truncated: false,
    });
    expect(parsed[1]!.content).toContain("小田递出一杯热拿铁。");

    const ep1 = resolveComicEpisodeMasterScript(script, 1);
    expect(ep1).toMatchObject({
      matched: "episode",
      episodeNo: 1,
      title: "雨夜里的过期快乐",
      totalParsedEpisodes: 2,
    });
    const ep3 = resolveComicEpisodeMasterScript(script, 3);
    expect(ep3).toEqual({
      matched: "none",
      episodeNo: 3,
      title: "",
      content: "",
      truncated: false,
      totalParsedEpisodes: 2,
    });
  });

  it("parses English/Indonesian headings, markdown wrappers, colon outside bracket, and inline body", () => {
    const script = [
      "[Episode 1: Rainy Convenience Store]",
      "Scene: Midnight convenience store.",
      "",
      "## **EP 2 - Warm Coffee**",
      "Xiaotian pours a cup of coffee.",
      "",
      "【第 3 集】：雨夜风铃",
      "风铃清脆作响。",
      "",
      "【第 4 集】雨夜风铃响起，两人对视。",
      "门外雨声渐大。",
    ].join("\n");

    const parsed = parseComicDramaMasterScript(script);
    expect(parsed.map(ep => [ep.episodeNo, ep.title])).toEqual([
      [1, "Rainy Convenience Store"],
      [2, "Warm Coffee"],
      [3, "雨夜风铃"],
      [4, ""],
    ]);
    expect(parsed[3]!.content).toContain("【第 4 集】雨夜风铃响起，两人对视。");
    expect(parsed[3]!.preview).toContain("雨夜风铃响起，两人对视。");
  });

  it("parses Chinese numerals accurately and rejects malformed numeral tokens", () => {
    const script = [
      "第一集：初遇",
      "雨夜街头。",
      "第两集：番外",
      "忽略",
      "第十二集：重逢",
      "便利店灯光温暖。",
      "第一百零五集：终章",
      "晨光微亮。",
      "第一一集：非法数字",
      "应归入前面段落。",
      "第十十集：非法单位",
      "也应归入前面段落。",
    ].join("\n");

    const parsed = parseComicDramaMasterScript(script);
    expect(parsed.map(ep => [ep.episodeNo, ep.title])).toEqual([
      [1, "初遇"],
      [2, "番外"],
      [12, "重逢"],
      [105, "终章"],
    ]);
    expect(parsed.find(ep => ep.episodeNo === 105)?.content).toContain("第一一集：非法数字");
  });

  it("rejects narrative prose false positives and prefers body match over TOC headers", () => {
    const script = [
      "目录：",
      "第 1 集：风铃",
      "第 2 集：热咖啡",
      "",
      "第 1 集：风铃",
      "第 3 集结尾留反转钩子，不要在这里切分。",
      "第一集的伏笔在此时回收。",
      "Episode 2 is about redemption and should not split here.",
      "",
      "第 2 集：热咖啡",
      "凌晨两点，咖啡机发出轻响。",
    ].join("\n");

    const parsed = parseComicDramaMasterScript(script);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.content).toContain("第 3 集结尾留反转钩子");
    expect(parsed[0]!.content).toContain("Episode 2 is about redemption");
    expect(parsed[1]!.content).toContain("凌晨两点，咖啡机发出轻响。");
  });

  it("handles whole_fallback for Ep 1 vs none for Ep 2+, and safely truncates at 20,000 chars", () => {
    const unsplit = "深夜便利店，丽丽独自坐在窗边。";
    expect(resolveComicEpisodeMasterScript(unsplit, 1)).toEqual({
      matched: "whole_fallback",
      episodeNo: 1,
      title: "",
      content: unsplit,
      truncated: false,
      totalParsedEpisodes: 0,
    });
    expect(resolveComicEpisodeMasterScript(unsplit, 2)).toEqual({
      matched: "none",
      episodeNo: 2,
      title: "",
      content: "",
      truncated: false,
      totalParsedEpisodes: 0,
    });

    const heading = "【第 1 集：超长剧本】\n";
    const filler = "a".repeat(COMIC_SCRIPT_MAX_CHARS - heading.length - 1) + "😀尾";
    const longScript = heading + filler;
    const res = resolveComicEpisodeMasterScript(longScript, 1);
    expect(res.matched).toBe("episode");
    expect(res.truncated).toBe(true);
    expect(res.content.length).toBeLessThanOrEqual(COMIC_SCRIPT_MAX_CHARS);
    expect(/[\uD800-\uDBFF]$/u.test(res.content)).toBe(false);
  });

  it("validates structured and legacy breakdown schemas and detects blank clip drafts", () => {
    expect(isComicClipDraftBlank({
      schemaVersion: 1,
      durationMs: 6000,
      scene: "",
      shots: [],
      lines: [],
    })).toBe(true);

    expect(isComicClipDraftBlank({
      schemaVersion: 1,
      durationMs: 6000,
      scene: "便利店门口",
      shots: [],
      lines: [],
    })).toBe(false);

    expect(isComicClipDraftBlank({
      schemaVersion: 1,
      durationMs: 6000,
      scene: "",
      shots: [{ id: "11111111-1111-4111-8111-111111111111", framingKey: "medium", movementKey: "fixed", description: "特写", durationShare: 100 }],
      lines: [],
    })).toBe(false);

    const legacy = comicDirectorBreakdownSchema.safeParse({
      clips: [{ scene: "雨夜", durationMs: 5000, shots: ["远景镜头"], lines: [{ speaker: null, text: "暴雨落下" }] }],
      characters: [],
    });
    expect(legacy.success).toBe(true);

    const structured = comicDirectorBreakdownSchema.safeParse({
      clips: [{
        scene: "写字楼深夜",
        durationMs: 6000,
        shots: [{ framingKey: "close_up", movementKey: "push", description: "键盘特写", durationShare: 100 }],
        lines: [{ speaker: "丽丽", text: "又被驳回了。", emotionKey: "sad", speed: 1 }],
      }],
      characters: [{ name: "丽丽", description: "加班白领" }],
    });
    expect(structured.success).toBe(true);
  });
});
