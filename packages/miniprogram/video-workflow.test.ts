import { describe, expect, it } from "vitest";
import { VIDEO_MODELS, buildVideoPrompt, createVideoDraft, videoSettings } from "./miniprogram/services/video";

describe("video creative brief", () => {
  it("maps all three tiers to the exact requested model IDs", () => {
    expect(VIDEO_MODELS.map(({ label, id }) => [label, id])).toEqual([
      ["旗舰", "doubao-seedance-2-5"], ["质量", "doubao-seedance-2-0"], ["快速", "minimax-video-h3"],
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
