import { describe, expect, it } from "vitest";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { marketingSegmentPrompt } from "./prompt.js";

describe("marketing model subtitle instructions", () => {
  it.each(["欢迎来到咖啡店。", "Welcome to our coffee shop."])("requests matching subtitles for each shot: %s", (script) => {
    const draft = MarketingDraftSchema.parse({ script: `${script}其他片段。`, subtitles: true });
    const prompt = marketingSegmentPrompt(draft, { index: 1, script, durationSec: 15 }, 4);
    expect(prompt).toContain("Create shot 2 of 4");
    expect(prompt).toContain(`Narrate ONLY this text, verbatim, finishing within the shot: ${script}`);
    expect(prompt).toContain("subtitles matching ONLY this shot's narration verbatim");
    expect(prompt).toContain("in the same language and synchronized with the speech");
    expect(prompt).not.toContain("其他片段");
    expect(prompt).not.toContain("No on-screen text, subtitles");
    expect(prompt).not.toContain("Do not add on-screen text or subtitles");
  });
  it("includes the confirmed visual, action and camera directions for the correct shot", () => {
    const storyboard = [
      { script: "第一段。", visual: "木质吧台", action: "端起咖啡", camera: "缓慢推近" },
      { script: "第二段。", visual: "明亮座位", action: "轻轻招手", camera: "侧向平移" },
    ];
    const draft = MarketingDraftSchema.parse({ storyboard });
    const prompt = marketingSegmentPrompt(draft, { index: 1, script: "第二段。", durationSec: 15 }, 2);
    for (const value of ["明亮座位", "轻轻招手", "侧向平移"]) expect(prompt).toContain(value);
    expect(prompt).not.toContain("木质吧台");
  });
  it("requests no subtitles when the option is off while preserving voice references", () => {
    const draft = MarketingDraftSchema.parse({ subtitles: false, assets: { voice: "11111111-1111-4111-8111-111111111111" } });
    const prompt = marketingSegmentPrompt(draft, { index: 0, script: "欢迎光临。", durationSec: 15 }, 2);
    expect(prompt).toContain("Do not add on-screen text or subtitles.");
    expect(prompt).not.toContain("Generate clear, readable on-screen subtitles");
    expect(prompt).toContain("Use audio 1 for the narrator's voice.");
  });
});
