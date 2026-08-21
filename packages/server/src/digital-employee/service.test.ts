import { describe, expect, it, vi } from "vitest";
import { SecretBox } from "../auth/secret-box.js";
import { DigitalEmployeeService } from "./service.js";

function serviceWith(
  repository: Record<string, unknown>,
  db: Record<string, unknown> = {},
  cohortSummaryGenerator?: { generate: (input: any) => Promise<{ summary: string; modelId: string }> }
) {
  const service = new DigitalEmployeeService({ pool: {}, ...db } as any, new SecretBox(), cohortSummaryGenerator);
  (service as any).repository = repository;
  return service;
}

function draft(row: any) {
  return {
    ...row,
    operation: row.operation,
    status: row.status,
    risks: row.risks,
  };
}

describe("DigitalEmployeeService acquisition lead return", () => {
  it("replays an identical lead payload without creating another profile", async () => {
    const insertManualAction = vi.fn();
    const getAction = vi.fn(async () => ({ id: "a1", profileId: "p1", title: "跟进李静的活动咨询" }));
    const client = { query: vi.fn(async () => ({ rows: [{ id: "a1" }] })) };
    const service = serviceWith({
      transaction: vi.fn(async (operation: (c: typeof client) => Promise<unknown>) => operation(client)),
      getObservationBySource: vi.fn(async () => ({ id: "obs1", profileId: "p1" })),
      getProfile: vi.fn(async () => ({
        id: "p1", displayName: "李静", aliases: [], customerKind: "person", organization: null,
        department: null, title: null, customerRegion: null, contactCiphertext: null, source: "获客宝",
        relationshipStage: "lead", overallHealth: "healthy", tags: [], customFields: {}, summary: "",
        summaryVersion: 1, manualLockFields: [], lastObservedAt: null, lastContactAt: null, nextFollowUpAt: null,
        version: 1, status: "active", archivedAt: null, createdAt: "", updatedAt: "", userId: "u1", ownerUserId: "u1",
      })),
      createProfile: vi.fn(),
    });
    (service as any).opportunities = { insertManualAction, getAction };

    const first = await service.returnAcquisitionLead("u1", { displayName: "李静", sourceCampaign: "分享会", quote: "想看演示" });
    const second = await service.returnAcquisitionLead("u1", { displayName: "李静", sourceCampaign: "分享会", quote: "想看演示" });

    expect(first.alreadyApplied).toBe(true);
    expect(second.alreadyApplied).toBe(true);
    expect(first.profile.id).toBe("p1");
    expect(insertManualAction).not.toHaveBeenCalled();
    expect((service as any).repository.createProfile).not.toHaveBeenCalled();
  });
});

describe("DigitalEmployeeService archive", () => {
  const profile = {
    id: "p1", displayName: "李静", aliases: [], customerKind: "person", organization: null,
    department: null, title: null, customerRegion: null, contactCiphertext: null, source: null,
    relationshipStage: "lead", overallHealth: "healthy", tags: [], customFields: {}, summary: "",
    summaryVersion: 1, manualLockFields: [], lastObservedAt: null, lastContactAt: null, nextFollowUpAt: null,
    version: 1, status: "active", archivedAt: null, createdAt: "", updatedAt: "", userId: "u1", ownerUserId: "u1",
  };

  it("refuses to archive when open tasks exist and cancel/keep was not chosen", async () => {
    const cancelOpenWorkForProfile = vi.fn();
    const archiveProfile = vi.fn(async () => ({ ...profile, status: "archived", version: 2 }));
    const service = serviceWith({
      getProfile: vi.fn(async () => profile),
      transaction: vi.fn(async (operation: (c: unknown) => Promise<unknown>) => operation({})),
      archiveProfile,
    });
    (service as any).opportunities = { countOpenTasks: vi.fn(async () => 2), cancelOpenWorkForProfile };

    await expect(service.archiveProfile("u1", "p1", 1)).rejects.toMatchObject({
      code: "open_tasks",
      openTaskCount: 2,
    });
    expect(cancelOpenWorkForProfile).not.toHaveBeenCalled();
  });

  it("cancels open follow-ups when archiving with onOpenTasks=cancel", async () => {
    const cancelOpenWorkForProfile = vi.fn();
    const service = serviceWith({
      getProfile: vi.fn(async () => profile),
      transaction: vi.fn(async (operation: (c: unknown) => Promise<unknown>) => operation({ tag: "tx" })),
      archiveProfile: vi.fn(async () => ({ ...profile, status: "archived", version: 2 })),
    });
    (service as any).opportunities = { countOpenTasks: vi.fn(async () => 1), cancelOpenWorkForProfile };

    const result = await service.archiveProfile("u1", "p1", 1, "cancel");

    expect(result.status).toBe("archived");
    expect(cancelOpenWorkForProfile).toHaveBeenCalledWith("u1", "p1", { tag: "tx" });
  });

  it("keeps open follow-ups when archiving with onOpenTasks=keep", async () => {
    const cancelOpenWorkForProfile = vi.fn();
    const service = serviceWith({
      getProfile: vi.fn(async () => profile),
      transaction: vi.fn(async (operation: (c: unknown) => Promise<unknown>) => operation({})),
      archiveProfile: vi.fn(async () => ({ ...profile, status: "archived", version: 2 })),
    });
    (service as any).opportunities = { countOpenTasks: vi.fn(async () => 1), cancelOpenWorkForProfile };

    await service.archiveProfile("u1", "p1", 1, "keep");
    expect(cancelOpenWorkForProfile).not.toHaveBeenCalled();
  });

  it("archives without a task choice when the customer has no open follow-ups", async () => {
    const cancelOpenWorkForProfile = vi.fn();
    const service = serviceWith({
      getProfile: vi.fn(async () => profile),
      transaction: vi.fn(async (operation: (c: unknown) => Promise<unknown>) => operation({})),
      archiveProfile: vi.fn(async () => ({ ...profile, status: "archived", version: 2 })),
    });
    (service as any).opportunities = { countOpenTasks: vi.fn(async () => 0), cancelOpenWorkForProfile };

    await expect(service.archiveProfile("u1", "p1", 1)).resolves.toMatchObject({ status: "archived" });
    expect(cancelOpenWorkForProfile).not.toHaveBeenCalled();
  });
});

describe("DigitalEmployeeService profile changes", () => {
  it("allows a unique low-risk create to commit in the same agent turn", async () => {
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => []),
      createProfileChangeDraft: vi.fn(async (row) => draft(row)),
    });
    const result = await service.prepareProfileChange(
      "u1",
      { operation: "create", displayName: "李静", customerRegion: "深圳南山区" },
      { sourceMessageId: "00000000-0000-0000-0000-000000000001" }
    );
    expect(result.status).toBe("ready");
    expect(result.risks).toEqual([]);
  });

  it("never treats a single fuzzy candidate as authorization to update", async () => {
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => []),
      listProfiles: vi.fn(async () => ({
        items: [{
          id: "00000000-0000-0000-0000-000000000002",
          displayName: "李静",
          customerRegion: "深圳南山区",
          version: 3,
        }],
        total: 1,
      })),
      createProfileChangeDraft: vi.fn(async (row) => draft(row)),
    });
    const result = await service.prepareProfileChange(
      "u1",
      { operation: "update", customerMention: "李姐", tags: ["重点客户"] },
      { sourceMessageId: "00000000-0000-0000-0000-000000000003" }
    );
    expect(result.status).toBe("needs_confirmation");
    expect(result.risks).toContain("identity_ambiguous");
    expect(result.options).toEqual(["李静（深圳南山区）"]);
  });

  it("resolves a pronoun only through the user-scoped conversation context", async () => {
    const findProfilesByExactMention = vi.fn();
    const service = serviceWith({
      findProfilesByExactMention,
      getProfile: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000002",
        displayName: "李静",
        customerRegion: "深圳南山区",
        status: "active",
        version: 4,
      })),
      createProfileChangeDraft: vi.fn(async (row) => draft(row)),
    }, {
      getConversationCustomerContext: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000002",
        displayName: "李静",
      })),
    });
    const result = await service.prepareProfileChange(
      "u1",
      { operation: "update", customerMention: "她", tags: ["重点客户"] },
      { conversationId: "00000000-0000-0000-0000-000000000010" }
    );
    expect(result.status).toBe("ready");
    expect(findProfilesByExactMention).not.toHaveBeenCalled();
  });
});

describe("DigitalEmployeeService cohort overview", () => {
  it("uses a live aggregate until the first nightly snapshot exists", async () => {
    const recent = [{
      id: "p1", userId: "u1", ownerUserId: "u1", displayName: "李静", aliases: [],
      customerKind: "person", organization: null, department: null, title: null,
      customerRegion: null, contactCiphertext: null, source: null, relationshipStage: "lead",
      overallHealth: "healthy", tags: [], customFields: {}, summary: "", summaryVersion: 1,
      manualLockFields: [], lastObservedAt: null, lastContactAt: null, nextFollowUpAt: null,
      version: 1, status: "active", archivedAt: null, createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    }];
    const service = serviceWith({
      listProfiles: vi.fn(async () => ({ items: recent, page: 1, limit: 5, total: 1 })),
      getLatestCohortSnapshot: vi.fn(async () => null),
      listActiveProfilesForCohort: vi.fn(async () => recent),
    });

    const overview = await service.getOverview("u1", new Date("2026-08-18T12:00:00.000Z"));
    expect(overview.totalProfiles).toBe(1);
    expect(overview.cohort.source).toBe("live");
    expect(overview.cohort.metrics.totalProfiles).toBe(1);
    expect(overview.schedule).toMatchObject({ localTime: "23:00", timeZone: "Asia/Shanghai" });
  });

  it("persists only users missing today's snapshot inside the nightly window", async () => {
    const upsertCohortSnapshot = vi.fn(async () => {});
    const service = serviceWith({
      listUsersMissingCohortSnapshot: vi.fn(async () => ["u1"]),
      listActiveProfilesForCohort: vi.fn(async () => []),
      upsertCohortSnapshot,
    });

    expect(await service.runNightlyCohortSummaries(new Date("2026-08-18T14:59:00.000Z"))).toBe(0);
    expect(await service.runNightlyCohortSummaries(new Date("2026-08-18T15:01:00.000Z"))).toBe(1);
    expect(upsertCohortSnapshot).toHaveBeenCalledWith("u1", expect.objectContaining({ snapshotDate: "2026-08-18" }));
    expect(upsertCohortSnapshot).toHaveBeenCalledWith("u1", expect.objectContaining({ generationMethod: "logic", modelId: null }));
  });

  it("prefers a valid LLM summary and records the model used", async () => {
    const upsertCohortSnapshot = vi.fn(async () => {});
    const generate = vi.fn(async () => ({
      summary: "客户整体活跃度保持稳定，潜客仍是当前主体。建议先处理到期跟进，并持续观察风险客户的变化。",
      modelId: "llm-primary",
    }));
    const service = serviceWith({
      listUsersMissingCohortSnapshot: vi.fn(async () => ["u1"]),
      listActiveProfilesForCohort: vi.fn(async () => []),
      upsertCohortSnapshot,
    }, {}, { generate });

    await service.runNightlyCohortSummaries(new Date("2026-08-18T15:01:00.000Z"));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", snapshotDate: "2026-08-18" }));
    expect(upsertCohortSnapshot).toHaveBeenCalledWith("u1", expect.objectContaining({
      generationMethod: "llm",
      modelId: "llm-primary",
      summary: expect.stringContaining("到期跟进"),
    }));
  });

  it("persists the deterministic summary when the LLM fails", async () => {
    const upsertCohortSnapshot = vi.fn(async () => {});
    const service = serviceWith({
      listUsersMissingCohortSnapshot: vi.fn(async () => ["u1"]),
      listActiveProfilesForCohort: vi.fn(async () => []),
      upsertCohortSnapshot,
    }, {}, { generate: vi.fn(async () => { throw new Error("upstream timeout"); }) });

    expect(await service.runNightlyCohortSummaries(new Date("2026-08-18T15:01:00.000Z"))).toBe(1);
    expect(upsertCohortSnapshot).toHaveBeenCalledWith("u1", expect.objectContaining({
      generationMethod: "logic",
      modelId: null,
      summary: expect.stringContaining("暂时还没有客户画像"),
    }));
  });
});
