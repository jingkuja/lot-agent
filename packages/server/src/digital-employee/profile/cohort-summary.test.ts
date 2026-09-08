import { describe, expect, it } from "vitest";
import {
  buildCohortSnapshot,
  cohortLlmMetrics,
  cohortDateKey,
  isCohortNightlyWindow,
  nextCohortRunAt,
  parseLlmCohortSummary,
} from "./cohort-summary.js";
import type { StoredCustomerProfile } from "../types.js";

function profile(patch: Partial<StoredCustomerProfile> = {}): StoredCustomerProfile {
  return {
    id: "p1", userId: "u1", ownerUserId: "u1", displayName: "李静", aliases: [],
    customerKind: "person", organization: null, department: null, title: null,
    customerRegion: null, contactCiphertext: null, source: null, relationshipStage: "prospect",
    overallHealth: "healthy", tags: [], customFields: {}, summary: "", summaryVersion: 1,
    manualLockFields: [], lastObservedAt: null, lastContactAt: null, nextFollowUpAt: null,
    version: 1, status: "active", archivedAt: null, createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z", ...patch,
  };
}

describe("customer cohort summary", () => {
  it("builds stage, health, activity and tag aggregates without customer names", () => {
    const now = new Date("2026-08-18T12:00:00.000Z");
    const snapshot = buildCohortSnapshot([
      profile({ id: "p1", tags: ["高意向", "华东"], nextFollowUpAt: "2026-08-18T00:00:00.000Z" }),
      profile({ id: "p2", relationshipStage: "customer", overallHealth: "at_risk", tags: ["高意向"] }),
    ], now);

    expect(snapshot.metrics).toMatchObject({ totalProfiles: 2, activeLast7Days: 2, dueFollowUps: 1 });
    expect(snapshot.metrics.topTags[0]).toEqual({ key: "高意向", label: "高意向", count: 2 });
    expect(snapshot.summary).toContain("2 位客户");
    expect(snapshot.summary).not.toContain("李静");
    expect(snapshot.generationMethod).toBe("logic");
  });

  it("uses 23:00 Asia/Shanghai as the idempotent nightly boundary", () => {
    const before = new Date("2026-08-18T14:59:59.000Z");
    const after = new Date("2026-08-18T15:00:00.000Z");
    expect(cohortDateKey(before)).toBe("2026-08-18");
    expect(isCohortNightlyWindow(before)).toBe(false);
    expect(isCohortNightlyWindow(after)).toBe(true);
    expect(nextCohortRunAt(before)).toBe("2026-08-18T15:00:00.000Z");
    expect(nextCohortRunAt(after)).toBe("2026-08-19T15:00:00.000Z");
  });

  it("accepts concise LLM copy and rejects unusable output", () => {
    expect(parseLlmCohortSummary("```text\n近七天客户活跃度稳定，建议优先跟进已到期客户，并持续关注风险客户。\n```")).toContain("优先跟进");
    expect(() => parseLlmCohortSummary("太短")).toThrow();
  });

  it("removes free-form tag labels from the metrics sent to the LLM", () => {
    const safe = cohortLlmMetrics("2026-08-18", {
      totalProfiles: 2,
      activeLast7Days: 1,
      dueFollowUps: 0,
      relationshipStages: [{ key: "lead", label: "线索", count: 2 }],
      health: [{ key: "healthy", label: "健康", count: 2 }],
      topTags: [{ key: "李静的手机号", label: "李静的手机号", count: 1 }],
    });
    expect(JSON.stringify(safe)).not.toContain("李静");
    expect(safe.topTagFrequencies).toEqual([1]);
  });
});
