import { describe, expect, it } from "vitest";
import { MarketingDraftSchema, resolveMarketingSegments, storyboardScript, GROK_MARKETING_PROFILE, type MarketingShot } from "@lot-agent/core/marketing-video";
import { insertShot, mergeShots, moveShot, removeShot, setShotDuration, shotsWithoutTake, splitShot } from "./shot-structure.js";

const shot = (durationSec: number, script: string, visual = "咖啡店"): MarketingShot => ({ durationSec, script, visual, action: "展示咖啡", camera: "中景" });
const board = [shot(10, "欢迎来到转角咖啡店，现磨咖啡等你来。"), shot(10, "店里的拿铁很香。", "拿铁特写"), shot(10, "周末带朋友一起来吧。", "座位区")];

describe("storyboard structure edits (assessment M03)", () => {
  it("moves, inserts and removes shots, refusing edits that do not apply", () => {
    expect(moveShot(board, 1, -1)?.map(s => s.visual)).toEqual(["拿铁特写", "咖啡店", "座位区"]);
    expect(moveShot(board, 0, -1)).toBeNull();
    expect(moveShot(board, 2, 1)).toBeNull();
    const inserted = insertShot(board, 0)!;
    expect(inserted).toHaveLength(4);
    expect(inserted[1]).toEqual({ durationSec: 4, script: "", visual: "", action: "", camera: "" });
    expect(insertShot(Array.from({ length: 15 }, () => shot(4, "欢迎光临。")), 0)).toBeNull();
    expect(removeShot(board, 1)?.map(s => s.visual)).toEqual(["咖啡店", "座位区"]);
    expect(removeShot([board[0]], 0)).toBeNull();
    expect(setShotDuration(board, 2, 12).map(s => s.durationSec)).toEqual([10, 10, 12]);
  });

  it("splits a line at the phrase boundary nearest its middle and its time by what each part says", () => {
    const split = splitShot(board, 0)!;
    expect(split.slice(0, 2).map(s => s.script)).toEqual(["欢迎来到转角咖啡店，", "现磨咖啡等你来。"]);
    expect(split.slice(0, 2).map(s => s.durationSec)).toEqual([6, 4]);
    expect(split[1].visual).toBe("咖啡店");
    expect(storyboardScript(split)).toBe(["欢迎来到转角咖啡店，", "现磨咖啡等你来。", board[1].script, board[2].script].join("\n"));
    // A short shot still splits into two shots the model accepts; the plan then reports the longer board.
    expect(splitShot([shot(5, "你好，欢迎。")], 0)!.map(s => s.durationSec)).toEqual([4, 4]);
    expect(splitShot([shot(4, "好")], 0)).toBeNull();
  });

  it("merges a shot with the next one up to the longest shot allowed", () => {
    const merged = mergeShots(board, 0, 15)!;
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ durationSec: 15, script: `${board[0].script}\n${board[1].script}`, visual: "咖啡店\n拿铁特写",
      action: "展示咖啡\n展示咖啡", camera: "中景\n中景" });
    expect(mergeShots(board, 2, 15)).toBeNull();
    // Too much to say in one 8-second shot.
    expect(mergeShots([shot(8, "欢".repeat(30)), shot(8, "迎".repeat(30))], 0, 8)).toBeNull();
  });

  it("keeps a restructured board valid for generation when its time fits", () => {
    const draft = (shots: MarketingShot[], durationSec: number) =>
      MarketingDraftSchema.parse({ durationSec, storyboard: shots, script: storyboardScript(shots) });
    const moved = moveShot(board, 0, 1)!;
    expect(resolveMarketingSegments(draft(moved, 30), GROK_MARKETING_PROFILE).map(s => s.script)).toEqual(moved.map(s => s.script));
    expect(() => resolveMarketingSegments(draft(removeShot(board, 0)!, 30), GROK_MARKETING_PROFILE)).toThrow("分镜总时长");
  });

  it("names the shots whose line has no narration take", () => {
    const takes = new Set(board.map(s => s.script));
    expect(shotsWithoutTake(moveShot(board, 0, 1)!, takes)).toEqual([]);
    expect(shotsWithoutTake(splitShot(board, 0)!, takes)).toEqual([0, 1]);
    expect(shotsWithoutTake(insertShot(board, 0)!, takes)).toEqual([]);
  });
});
