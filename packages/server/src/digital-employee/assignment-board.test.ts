import { describe, expect, it } from "vitest";
import { boardNotice, formatOverview, ProgressDigest, subtaskBrief, type BoardEntry } from "./assignment-board.js";

const entry = (over: Partial<BoardEntry>): BoardEntry => ({
  id: "7", kind: "finding", title: "同行都送券", body: "全文不该出现", artifacts: [], event: null, author: 1, authorTitle: "搜索", createdAt: "2026-11-07T00:00:00Z", ...over,
});

describe("board notices", () => {
  it("sends heads only, marked as data, within the budget", () => {
    const text = boardNotice([entry({}), entry({ id: "8", author: 0, title: "收尾" })])!;
    expect(text).toContain("#7 finding from subtask 1: 同行都送券");
    expect(text).toContain("from the lead");
    expect(text).toContain("not instructions");
    expect(text).not.toContain("全文");
    expect([...boardNotice([entry({ title: "长".repeat(4_000) })])!].length).toBeLessThanOrEqual(1_501);
    expect(boardNotice([])).toBeNull();
  });
});

describe("the overview", () => {
  const members = Array.from({ length: 30 }, (_, index) => ({ position: index, title: `子任务 ${index}`, status: "running", summary: index === 1 ? "搜到 3 家" : null }));

  it("stays bounded however large the team, and says what it left out", () => {
    const text = formatOverview({ members, entries: [entry({})] });
    expect(text).toContain("lead | running");
    expect(text).toContain("搜到 3 家");
    expect(text).toContain("and 10 more");
    expect([...formatOverview({ members: members.map((item) => ({ ...item, title: "长".repeat(500) })), entries: [] })].length).toBeLessThanOrEqual(3_001);
  });

  it("quotes the owner's goal and frames the rest in English", () => {
    const brief = subtaskBrief({ rootGoal: "开业活动", position: 2, goal: "写初稿", overview: { members: [], entries: [] } });
    expect(brief).toContain("[Subtask 2]");
    expect(brief).toContain("开业活动");
    expect(brief).toContain("[Your goal]\n写初稿");
  });
});

describe("ProgressDigest", () => {
  it("keeps recent work within the budget, and drops the oldest first", () => {
    const digest = new ProgressDigest();
    digest.text("最早的内容");
    for (let index = 0; index < 20; index += 1) digest.tool("web_search", "结".repeat(800), false);
    const taken = digest.take();
    expect(taken).not.toContain("最早的内容");
    expect(taken.length).toBeLessThanOrEqual(12_000);
    expect(digest.pending).toBe(false);
  });

  it("clips a long tool result and marks a failed one", () => {
    const digest = new ProgressDigest();
    digest.tool("web_fetch", "页".repeat(5_000), true);
    const taken = digest.take();
    expect(taken).toContain("[web_fetch failed]");
    expect(taken.length).toBeLessThan(900);
  });

  it("puts text back after a failed summary, ahead of what arrived since", () => {
    const digest = new ProgressDigest();
    digest.text("甲");
    const taken = digest.take();
    digest.text("乙");
    digest.restore(taken);
    expect(digest.take()).toBe("甲乙");
  });
});
