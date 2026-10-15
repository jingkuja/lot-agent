import { describe, expect, it } from "vitest";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { marketingSegmentPrompt } from "./prompt.js";
import { creationPrompt } from "./creation.js";

describe("marketing model subtitle instructions", () => {
  it("requires a visible identifiable presenter in creation and every video shot, even when selected after the board", () => {
    const draft = MarketingDraftSchema.parse({ assets: { portrait: "11111111-1111-4111-8111-111111111111" }, durationSec: 17,
      storyboard: [{ durationSec: 6, script: "欢迎光临。", visual: "Product-only close-up", action: "展示杯子", camera: "特写" }] });
    const creation = creationPrompt(draft, "zh").system;
    expect(creation).toContain("between 17 and 22 seconds, never over 65"); expect(creation).toContain("integer durationSec of 4–15 seconds");
    for (const prompt of [creation, marketingSegmentPrompt(draft, { index: 0, script: "欢迎光临。", durationSec: 6 }, 2)]) {
      expect(prompt).toContain("visibly on camera in EVERY shot");
      expect(prompt).toContain("match the supplied portrait identity");
      expect(prompt).toContain("takes precedence over conflicting shot directions");
    }
    expect(marketingSegmentPrompt(draft, { index: 0, script: "欢迎光临。", durationSec: 6 }, 2)).toContain("Duration exactly 6 seconds");
  });
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

it("numbers portrait, background and scene references in submission order", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const draft = MarketingDraftSchema.parse({ assets: { portrait: [id, id, id], background: [id, id], scene: [id] } });
  const prompt = marketingSegmentPrompt(draft, { index: 0, script: "Hello", durationSec: 15 }, 1);
  expect(prompt).toContain("Use image 3 for the presenter's appearance.");
  expect(prompt).toContain("Use image 4 for the setting.");
  expect(prompt).toContain("Use image 6 for the scene composition and details.");

});

it("uses reference video for silent visuals without requesting voice synthesis", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const draft = MarketingDraftSchema.parse({ assets: { video: id, voice: id } });
  const prompt = marketingSegmentPrompt(draft, { index: 0, script: "Hello", durationSec: 5 }, 1);
  expect(prompt).toContain("Use video 1 as a reference");
  expect(prompt).toContain("Do not generate speech or audio.");
  expect(prompt).not.toContain("Use audio 1");
  expect(prompt).not.toContain("Narrate ONLY");
});
