import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "./errors.js";
import { WorkLogService, stepArtifact } from "./work-log-service.js";

const NOW = "2026-11-05T02:00:00.000Z";

describe("stepArtifact", () => {
  it("names what a tool produced", () => {
    expect(stepArtifact("generate_campaign_copy", "succeeded", {
      content: JSON.stringify({ asset: { title: "门槛文案", content: "secret body" }, managementUrl: "/digital-employee/marketing" }),
    })).toEqual({ label: "门槛文案", url: "/digital-employee/marketing" });
  });

  it("reads the link a commit tool writes in chat", () => {
    expect(stepArtifact("commit_customer_capture", "succeeded", { content: "已记录。\n[查看画像](/digital-employee/customers/p1)" }))
      .toEqual({ label: "查看画像", url: "/digital-employee/customers/p1" });
  });

  it("opens the studio for a marketing video draft", () => {
    const url = "/assistant?agent=marketing_video&project=0a1b-2c";
    expect(stepArtifact("start_marketing_video", "succeeded", { content: JSON.stringify({ managementUrl: url }) })).toEqual({ label: null, url });
  });

  it("refuses a link that leaves the app", () => {
    for (const url of ["https://evil.example/", "//evil.example", "/digital-employee/../admin", "javascript:alert(1)"]) {
      expect(stepArtifact("generate_campaign_copy", "succeeded", { content: JSON.stringify({ title: "t", managementUrl: url }) })).toEqual({ label: "t", url: null });
    }
  });

  it("has nothing for reads and failures", () => {
    expect(stepArtifact("search_customer_profiles", "succeeded", { content: JSON.stringify({ title: "x" }) })).toBeNull();
    expect(stepArtifact("generate_campaign_copy", "failed", { content: JSON.stringify({ title: "x" }) })).toBeNull();
    expect(stepArtifact("commit_follow_up_action", "succeeded", { content: "not json" })).toBeNull();
  });
});

describe("WorkLogService", () => {
  it("does not read a conversation the account does not own", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(new WorkLogService({ query } as never).conversation("u2", "c1")).rejects.toBeInstanceOf(NotFoundError);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining("user_id=$2"), ["c1", "u2", "digital_employee"]]);
  });

  it("returns runs with their steps and never the raw tool data", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "c1", title: "跟进" }] })
      .mockResolvedValueOnce({ rows: [{ id: "r1", goal: "记一下", status: "completed", started_at: NOW, finished_at: NOW, outcome: "已记录" }] })
      .mockResolvedValueOnce({ rows: [
        { id: "s1", run_id: "r1", tool_name: "get_customer_profiles", status: "succeeded", result: { content: "{\"phone\":\"13800000000\"}" }, started_at: NOW, finished_at: NOW },
        { id: "s2", run_id: "other", tool_name: "ask_user", status: "succeeded", result: null, started_at: NOW, finished_at: null },
      ] });
    const work = await new WorkLogService({ query } as never).conversation("u1", "c1");
    expect(work.runs).toHaveLength(1);
    expect(work.runs[0]).toMatchObject({ goal: "记一下", outcome: "已记录", steps: [{ id: "s1", tool: "get_customer_profiles", artifact: null }] });
    expect(JSON.stringify(work)).not.toContain("13800000000");
  });
});
