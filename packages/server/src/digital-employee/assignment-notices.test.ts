import { afterEach, describe, expect, it, vi } from "vitest";
import { assignmentLink, costLimitNotice, finishedNotice, quotaNotice, decisionNotice, replyAck } from "./assignment-notices.js";

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

describe("decision notices", () => {
  const base = { name: "小灵", title: "开业活动", link: "https://app/x", reminder: false };

  it("names the task, numbers the choices and says how to answer", () => {
    const text = decisionNotice({ ...base, kind: "question", question: "哪位王总？", options: ["华东的", "华南的"] }, false);
    expect(text).toContain("「开业活动」");
    expect(text).toContain("2. 华南的");
    expect(text).toContain("引用这条消息");
    expect(text).toContain("https://app/x");
  });

  it("offers the four choices on a failure, in the order replies are read", () => {
    const text = decisionNotice({ ...base, kind: "failure", failureReason: "stalled" }, false);
    expect(text).toContain("连续几轮没有进展");
    expect(text.indexOf("1. 重试")).toBeLessThan(text.indexOf("2. 跳过"));
    expect(text.indexOf("3. 换个做法")).toBeLessThan(text.indexOf("4. 结束任务"));
    expect(text).not.toContain("核实");
  });

  it("warns before an unconfirmed write is retried, and marks a reminder", () => {
    const text = decisionNotice({ ...base, kind: "failure", failureReason: "unknown_outcome", reminder: true }, false);
    expect(text).toContain("核实");
    expect(text).toContain("已经等了一天");
  });

  it("has English copy for every outcome", () => {
    expect(decisionNotice({ ...base, kind: "failure", failureReason: "blocked" }, true)).toContain("3. Try another way");
    for (const outcome of ["continue", "skip", "end", "answered_already", "unverified", "quote_needed"] as const) {
      expect(replyAck(outcome, "https://app/x", true)).not.toMatch(/[一-龥]/);
    }
  });
});

describe("a partly finished task", () => {
  it("names what was not done", () => {
    const text = finishedNotice({ name: "小灵", title: "开业活动", status: "succeeded", link: "", missed: ["搜同行", "做海报"] }, false);
    expect(text).toContain("没完成的有：搜同行、做海报");
    expect(finishedNotice({ name: "L", title: "T", status: "succeeded", link: "", missed: ["A"] }, true)).toContain("Not done: A");
  });
});
