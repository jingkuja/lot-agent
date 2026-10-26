import { describe, expect, it } from "vitest";
import { GROK_MARKETING_PROFILE, MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { generationBlocker, generationChecks, generationConfirmation, narrationBlocker, unusableMaterial } from "./production-checks.js";

const image = "11111111-1111-4111-8111-111111111111";
const shots = [1, 2].map(() => ({ durationSec: 15, script: "欢迎来到转角咖啡店，现磨咖啡等你来。", visual: "咖啡店", action: "展示咖啡", camera: "中景" }));
const draft = MarketingDraftSchema.parse({ durationSec: 30, storyboard: shots, script: storyboardScript(shots) });
const narrated = MarketingDraftSchema.parse({ ...draft, narration: { twinItemId: image } });
const capabilities = { composition: true, subtitles: true, knowledge: true, narration: true };
const state = { ready: true, loadError: "", draft, profile: GROK_MARKETING_PROFILE, capabilities, materials: {}, planError: "", narration: null };

describe("generation blockers", () => {
  it("names the first reason generation cannot start", () => {
    expect(generationBlocker(state)).toBe("");
    expect(generationBlocker({ ...state, ready: false })).toBe("正在加载草稿…");
    expect(generationBlocker({ ...state, ready: false, loadError: "离线" })).toBe("离线");
    expect(generationBlocker({ ...state, planError: "分镜口播与文案不一致，请重新生成分镜。" })).toBe("分镜口播与文案不一致，请重新生成分镜。");
    expect(generationBlocker({ ...state, capabilities: { ...capabilities, composition: false } })).toBe("视频合成工具不可用，请配置 FFmpeg 和 FFprobe。");
    expect(generationBlocker({ ...state, capabilities: { ...capabilities, subtitles: false } })).toBe("当前环境不支持字幕，可关闭字幕后生成。");
    const off = MarketingDraftSchema.parse({ ...draft, subtitles: false });
    expect(generationBlocker({ ...state, draft: off, capabilities: { ...capabilities, subtitles: false } })).toBe("");
    // A key-art still is submitted with the clips, so 1080p is refused before anything is paid.
    const hd = MarketingDraftSchema.parse({ ...draft, quality: "1080p" });
    expect(generationBlocker({ ...state, draft: hd })).toBe("");
    expect(generationBlocker({ ...state, draft: hd, keyArt: true })).toBe("使用定妆图时最高支持 720p，请将画质改为 720p。");
  });
  it("blocks a material that is gone or no longer accepted", () => {
    const withImage = MarketingDraftSchema.parse({ ...draft, assets: { portrait: [image] } });
    expect(unusableMaterial(withImage, {})).toBe(true);
    const material = { id: image, url: "/u", name: "p.png", mime: "image/png" };
    expect(unusableMaterial(withImage, { [image]: material })).toBe(false);
    expect(unusableMaterial(withImage, { [image]: { ...material, issue: "unsupported" as const } })).toBe(true);
    expect(generationBlocker({ ...state, draft: withImage })).toBe("素材已不可用或不支持新生成，请移除或替换。");
  });
  it("waits for a fitting twin narration take of every shot", () => {
    expect(narrationBlocker(narrated, { ...capabilities, narration: false }, "", null)).toBe("数字分身配音服务未启用，请改用 AI 配音。");
    expect(narrationBlocker(MarketingDraftSchema.parse({ ...draft, narration: {} }), capabilities, "", null)).toBe("请先选择数字分身旁白音色。");
    expect(narrationBlocker(narrated, capabilities, "", null)).toBe("请先生成全部分镜的数字分身配音并试听。");
    expect(narrationBlocker(narrated, capabilities, "计划错误", null)).toBe("");
    const takes = (ms: number) => shots.map((_, slot) => ({ slot, status: "succeeded" as const, durationMs: ms }));
    expect(narrationBlocker(narrated, capabilities, "", takes(3000))).toBe("");
    expect(narrationBlocker(narrated, capabilities, "", takes(14900))).toBe("有分镜的配音长于镜头时长，请按配音调整分镜时长。");
    expect(narrationBlocker(draft, capabilities, "", null)).toBe("");
  });
});

describe("checks before generating", () => {
  const confirmed = (checks: ReturnType<typeof generationChecks>) => checks.filter(check => check.confirm).map(check => check.text);
  it("lists what generating does, and asks once for everything that needs accepting", () => {
    const titled = MarketingDraftSchema.parse({ ...draft, publishTitle: "标题", tags: "#咖啡" });
    const ready = generationChecks(titled, { keyArt: true, review: "pass" });
    expect(ready.map(check => check.state)).toEqual(["ok", "ok"]);
    expect(generationConfirmation(ready, text => text)).toBeUndefined();
    // Not checked yet, no titles: both happen while generating, without a question.
    expect(generationChecks(draft, { keyArt: true }).map(check => check.state)).toEqual(["ok", "auto", "auto"]);
    expect(generationChecks(draft, { review: "reject" }).find(check => check.state === "block")?.text).toContain("请修改后再生成");
    // A check with findings to verify is shown, but does not ask.
    expect(confirmed(generationChecks(draft, { review: "suspect" }))).toEqual([]);
  });
  it("asks about a board planned for the other reference video setting and a missing key-art still in one dialog", () => {
    const silent = MarketingDraftSchema.parse({ ...draft, storyboardAudio: false });
    const checks = generationChecks(silent, { keyArt: false });
    expect(confirmed(checks)).toEqual(["已移除动作参考视频，但分镜按无声展示编写。建议先重新生成分镜。", "未生成定妆图，也没有参考图，各镜头的人物、产品和场景可能不同。"]);
    const dialog = generationConfirmation(checks, text => `[${text}]`)!;
    expect(dialog.message.split("\n")).toEqual([...confirmed(checks).map(text => `[${text}]`), "[仍要生成视频吗？]"]);
    const withImage = MarketingDraftSchema.parse({ ...draft, assets: { portrait: [image] } });
    expect(confirmed(generationChecks(withImage, { keyArt: false }))).toEqual(["未生成定妆图，各镜头只靠文字保持人物和场景一致。"]);
    // A video that takes no still has no line about it.
    expect(generationChecks(draft, {}).some(check => check.text.includes("定妆图"))).toBe(false);
  });
});
