import { describe, expect, it } from "vitest";
import { VIDEO_MODELS, buildVideoPrompt, createVideoDraft, restoreVideoDraft, videoErrorText, videoSettings, videoSignature } from "./miniprogram/services/video";

describe("video creative brief", () => {
  it("maps all three tiers to the exact requested model IDs", () => {
    expect(VIDEO_MODELS.map(({ label, id }) => [label, id])).toEqual([
      ["旗舰", "doubao-seedance-2-5"], ["质量", "doubao-seedance-2-0"], ["快速", "doubao-seedance-2-0-fast"],
    ]);
  });
  it.each([[0, "1080p"], [1, "720p"], [2, "480p"]] as const)("sends resolution for tier %s independently of aspect ratio", (modelIndex, resolution) => {
    for (const ratio of ["9:16", "16:9", "1:1"]) {
      expect(videoSettings({ ...createVideoDraft(), modelIndex, ratio })).toMatchObject({ resolution, ratio });
    }
  });
  it("includes edited script, audio, subtitles and cover in the generation request", () => {
    const draft = { ...createVideoDraft(), script: "清晨的咖啡店", mainTitle: "新店开业", subtitle: "欢迎光临", voice: "温柔女声", bgm: "轻快", subtitles: true };
    const prompt = buildVideoPrompt(draft);
    for (const text of [draft.script, draft.mainTitle, draft.subtitle, draft.voice, draft.bgm, "字幕"]) expect(prompt).toContain(text);
    expect(videoSettings(draft)).toMatchObject({ ratio: "9:16", durationSec: 5, generate_audio: true });
  });
  it("turns off native audio only when both voice and music are disabled", () => {
    expect(videoSettings({ ...createVideoDraft(), voice: "无配音", bgm: "无配乐" }).generate_audio).toBe(false);
    expect(videoSettings({ ...createVideoDraft(), voice: "无配音", bgm: "轻快" }).generate_audio).toBe(true);
  });
});

describe("video duplicate identity", () => {
  it("ignores publishing-only edits but detects model, script and first-frame changes", () => {
    const draft = { ...createVideoDraft(), script: "咖啡馆" };
    const identity = videoSignature(draft);
    expect(videoSignature({ ...draft, publishTitle: "新标题", tags: "#咖啡", topic: "新主题" })).toBe(identity);
    for (const change of [{ script: "新的分镜" }, { modelIndex: 2 }, { durationSec: 10 }, { cover: "cover.png" }, { subtitles: false }]) {
      expect(videoSignature({ ...draft, ...change })).not.toBe(identity);
    }
  });
});

describe("video draft restore", () => {
  it("falls back to defaults for retired options, wrong types and unknown keys", () => {
    const restored = restoreVideoDraft({ script: "分镜", voice: "已下线音色", bgm: 3, ratio: "4:3", durationSec: 15, modelIndex: 9, subtitles: "yes", extra: true });
    expect(restored).toMatchObject({ script: "分镜", voice: "自然旁白", bgm: "无配乐", ratio: "9:16", durationSec: 5, modelIndex: 0, subtitles: true });
    expect("extra" in restored).toBe(false);
    expect(restoreVideoDraft("junk")).toEqual(createVideoDraft());
  });
});

describe("video prompt titles", () => {
  it("omits the cover title line instead of sending blanks", () => {
    expect(buildVideoPrompt({ ...createVideoDraft(), script: "镜头" })).not.toContain("封面主标题");
    expect(buildVideoPrompt({ ...createVideoDraft(), script: "镜头", mainTitle: " 开业 " })).toContain("开场封面主标题：开业。");
    expect(buildVideoPrompt({ ...createVideoDraft(), script: "镜头", mainTitle: "开业", subtitle: "欢迎" })).toContain("开场封面主标题：开业；副标题：欢迎。");
  });
});

describe("video error text", () => {
  it("maps quota exhaustion and hides internal English messages", () => {
    expect(videoErrorText(Object.assign(new Error("daily limit 5 would be exceeded"), { status: 402 }), "x")).toBe("暂时无法生成，请检查账户余额或消费限额");
    expect(videoErrorText(Object.assign(new Error("first_frame must be a non-empty URL string"), { status: 400 }), "提交失败")).toBe("提交失败");
    expect(videoErrorText(new Error("提交结果待确认，请点「查询进度」"), "x")).toBe("提交结果待确认，请点「查询进度」");
    expect(videoErrorText("boom", "回退")).toBe("回退");
  });
});
