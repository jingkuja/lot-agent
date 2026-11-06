import { afterEach, describe, expect, it, vi } from "vitest";
import { assignmentLink, costLimitNotice, finishedNotice, quotaNotice } from "./assignment-notices.js";

afterEach(() => vi.unstubAllEnvs());

describe("notices to the owner", () => {
  it("reports a finished task with its result and a link", () => {
    const text = finishedNotice({ name: "小灵", title: "开业活动", status: "succeeded", summary: "方案写好了", link: "https://a.test/t" }, false);
    expect(text).toBe("小灵做完了「开业活动」。\n方案写好了\nhttps://a.test/t");
  });

  it("clips a long result", () => {
    const text = finishedNotice({ name: "小灵", title: "x", status: "succeeded", summary: "字".repeat(900), link: "" }, false);
    expect(text.length).toBeLessThan(530);
  });

  it("says why a task failed, in words", () => {
    expect(finishedNotice({ name: "Ling", title: "x", status: "failed", failureReason: "unknown_outcome", link: "" }, true))
      .toContain("check it before retrying");
    expect(finishedNotice({ name: "小灵", title: "x", status: "failed", link: "" }, false)).toContain("模型调用失败");
  });

  it("counts paused tasks in one message", () => {
    expect(quotaNotice({ name: "小灵", count: 3, link: "" }, false)).toContain("3 个任务");
    expect(quotaNotice({ name: "Ling", count: 1, link: "" }, true)).toContain("1 task:");
    expect(quotaNotice({ name: "Ling", count: 2, link: "" }, true)).toContain("2 tasks:");
  });

  it("explains a cost limit stop", () => {
    expect(costLimitNotice({ name: "小灵", title: "x", link: "" }, false)).toContain("调高上限");
  });

  it("links only when the deployment knows its address", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "");
    expect(assignmentLink("t1")).toBe("");
    vi.stubEnv("PUBLIC_BASE_URL", "https://a.test/");
    expect(assignmentLink("t1")).toBe("https://a.test/digital-employee/assignments/t1");
    expect(assignmentLink()).toBe("https://a.test/digital-employee/assignments");
  });
});
