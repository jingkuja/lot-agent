import { describe, expect, it } from "vitest";
import { GROK_MARKETING_PROFILE, KLING_MARKETING_PROFILE, MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { stableRequestId, withDraftField } from "./draft-editor.js";

const shot = (durationSec: number, script = "欢迎来到转角咖啡店，现磨咖啡等你来。") => ({ durationSec, script, visual: "咖啡店", action: "展示咖啡", camera: "中景" });
const board = (shots: ReturnType<typeof shot>[], durationSec: number, extra: object = {}) =>
  MarketingDraftSchema.parse({ durationSec, storyboard: shots, script: storyboardScript(shots), ...extra });

describe("draft field edits", () => {
  it("drops the shots when the copy is rewritten, and keeps everything for an unchanged value", () => {
    const draft = board([shot(15), shot(15)], 30);
    expect(withDraftField(draft, "script", "新的文案", GROK_MARKETING_PROFILE).storyboard).toEqual([]);
    expect(withDraftField(draft, "script", draft.script, GROK_MARKETING_PROFILE)).toEqual(draft);
    expect(withDraftField(draft, "topic", "咖啡", GROK_MARKETING_PROFILE).storyboard).toBe(draft.storyboard);
  });
  it("re-times the shots to a new duration", () => {
    const draft = board([shot(15), shot(15)], 30);
    expect(withDraftField(draft, "durationSec", 20, GROK_MARKETING_PROFILE).storyboard.map(s => s.durationSec)).toEqual([10, 10]);
  });
  it("drops shots that no longer fit the new duration (assessment D01: the shots came from a paid request)", () => {
    const long = "欢".repeat(60);
    const draft = board([shot(15, long), shot(15, long), shot(15, long), shot(15, long)], 60);
    expect(withDraftField(draft, "durationSec", 20, GROK_MARKETING_PROFILE).storyboard).toEqual([]);
  });
  it("records what a board was planned for when the reference video changes, and fits it to the new shot limit", () => {
    const draft = board([shot(15), shot(15)], 30);
    const withVideo = withDraftField(draft, "assets", { video: "11111111-1111-4111-8111-111111111111" }, KLING_MARKETING_PROFILE);
    expect(withVideo.storyboardAudio).toBe(true);
    expect(withVideo.storyboard).toHaveLength(2);
    // Grok allows 8-second shots with a reference video; two shots cannot fill 30 seconds, so the board stays for the plan to report.
    const grok = withDraftField(draft, "assets", { video: "11111111-1111-4111-8111-111111111111" }, GROK_MARKETING_PROFILE);
    expect(grok.storyboard.map(s => s.durationSec)).toEqual([15, 15]);
    expect(withDraftField(withVideo, "assets", {}, KLING_MARKETING_PROFILE).storyboardAudio).toBe(true);
  });
});

describe("recorded request IDs", () => {
  it("repeats the ID of an unchanged request and makes a new one when the request changes", () => {
    const ref = { current: null as { fingerprint: string; id: string } | null };
    let n = 0;
    const next = () => `id-${++n}`;
    expect(stableRequestId(ref, "a", next)).toBe("id-1");
    expect(stableRequestId(ref, "a", next)).toBe("id-1");
    expect(stableRequestId(ref, "b", next)).toBe("id-2");
    ref.current = null;
    expect(stableRequestId(ref, "b", next)).toBe("id-3");
  });
});
