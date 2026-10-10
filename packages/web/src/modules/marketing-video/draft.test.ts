import { describe, expect, it } from "vitest";
import { buildSubmission, createDraft, DIRECTIONS, MARKETING_VIDEO_QUALITIES, type Translate } from "./draft.js";
const t: Translate = (text, values = []) => text.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)]));
const file = (name: string) => ({ name } as File);

describe("marketing video submission", () => {
  it("preserves portrait/background ordering, audio and cover slots with numbered Kling references", () => {
    const result = buildSubmission({ ...createDraft(), script: "店铺介绍", publishTitle: "仅发布用", tags: "#仅分享用" }, {
      portrait: file("portrait.png"), background: file("store.png"), voice: file("voice.wav"), cover: file("cover.png"),
    }, t);
    expect(result.files.map((f) => [f.file.name, f.slot])).toEqual([
      ["portrait.png", "video_reference_image"], ["store.png", "video_reference_image"],
      ["voice.wav", "video_reference_audio"], ["cover.png", "video_first_frame"],
    ]);
    expect(result.prompt).toContain("外貌参考 图片1");
    expect(result.prompt).toContain("空间布局参考 图片2");
    expect(result.prompt).toContain("音频1");
    expect(result.prompt).not.toContain("仅发布用");
    expect(result.prompt).not.toContain("仅分享用");
    expect(result.settings.generate_audio).toBe(true);
  });
  it("renumbers a background without a portrait and supports skipping all assets", () => {
    expect(buildSubmission(createDraft(), { background: file("shop.png") }, t).prompt).toContain("空间布局参考 图片1");
    const result = buildSubmission(createDraft(), {}, t);
    expect(result.files).toEqual([]);
    expect(result.prompt).not.toContain("@Image");
    expect(result.settings).toMatchObject({ ratio: "9:16", durationSec: 5, quality: "720p", size: "720x1280" });
  });
  it("uses presenter direction and normalizes unsupported quality to the fixed Kling ladder", () => {
    const result = buildSubmission({ ...createDraft(), direction: DIRECTIONS[1], quality: "480p", voice: "无配音", bgm: "无配乐" }, {}, t);
    expect(result.prompt).toContain("面对镜头的自然口播");
    expect(result.settings).toMatchObject({ quality: "720p", generate_audio: false });
    expect(buildSubmission({ ...createDraft(), voice: "无配音", bgm: "无配乐" }, { voice: file("voice.wav") }, t).settings.generate_audio).toBe(true);
  });
  it("generates audio for music even when narration is disabled", () => {
    expect(buildSubmission({ ...createDraft(), voice: "无配音", bgm: "轻快" }, {}, t).settings.generate_audio).toBe(true);
  });
});

it.each(MARKETING_VIDEO_QUALITIES)("maps $label to $short without sending display labels", ({ short, edge }) => {
  const result = buildSubmission({ ...createDraft(), quality: short, ratio: "1:1" }, {}, t);
  expect(result.settings).toMatchObject({ quality: short, size: `${edge}x${edge}` });
});
