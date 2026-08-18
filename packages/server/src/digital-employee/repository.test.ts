import { describe, expect, it, vi } from "vitest";
import { DigitalEmployeeRepository } from "./repository.js";

describe("DigitalEmployeeRepository persistence parameters", () => {
  it("persists customer region as one plain text column", async () => {
    const now = new Date().toISOString();
    const query = vi.fn(async () => ({ rows: [{
      id: "p1", user_id: "u1", owner_user_id: "u1", display_name: "李姐",
      aliases: [], customer_kind: "person", customer_region: "华东 / 深圳南山区及周边",
      relationship_stage: "lead", overall_health: "healthy", tags: [], custom_fields: {},
      summary: "", summary_version: 1, manual_lock_fields: [], version: 1, status: "active",
      created_at: now, updated_at: now,
    }] }));
    const repository = new DigitalEmployeeRepository({ query } as any);

    const profile = await repository.createProfile({
      id: "p1", userId: "u1", ownerUserId: "u1", displayName: "李姐", aliases: [],
      customerKind: "person", organization: null, department: null, title: null,
      customerRegion: "华东 / 深圳南山区及周边", contactCiphertext: null, source: null,
      relationshipStage: "lead", overallHealth: "healthy", tags: [], customFields: {},
      summary: "", summaryVersion: 1, manualLockFields: [],
    });

    expect((query.mock.calls[0][0] as string)).toContain("customer_region");
    expect((query.mock.calls[0][1] as unknown[])[9]).toBe("华东 / 深圳南山区及周边");
    expect(profile.customerRegion).toBe("华东 / 深圳南山区及周边");
  });

  it("serializes capture draft JSONB arrays as JSON rather than PostgreSQL arrays", async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: "d1",
      user_id: "u1",
      conversation_id: null,
      source_message_id: null,
      raw_text: "李姐想租算力设备",
      candidate_profile_ids: ["p1"],
      proposed_observation: { capture: { eventType: "requirement" } },
      ambiguities: ["identity"],
      status: "awaiting_confirmation",
      expires_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }] }));
    const repository = new DigitalEmployeeRepository({ query } as any);

    await repository.createDraft({
      id: "d1",
      userId: "u1",
      rawText: "李姐想租算力设备",
      candidateProfileIds: ["p1"],
      proposedObservation: { capture: { eventType: "requirement" } },
      ambiguities: ["identity"],
      status: "awaiting_confirmation",
      expiresAt: new Date().toISOString(),
    });

    const params = query.mock.calls[0][1] as unknown[];
    expect(params[5]).toBe('["p1"]');
    expect(params[6]).toBe('{"capture":{"eventType":"requirement"}}');
    expect(params[7]).toBe('["identity"]');
  });

  it("serializes product-state list fields for JSONB columns", async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: "s1", user_id: "u1", profile_id: "p1", product_key: "compute",
      product_name: "算力设备出租", journey_stage: "evaluating", sentiment: "neutral",
      satisfaction: "unknown", health: "healthy", needs: ["算力设备出租"],
      objections: ["对价格敏感"], current_issues: [], manual_lock_fields: [],
      version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }] }));
    const repository = new DigitalEmployeeRepository({ query } as any);

    await repository.createProductState({
      id: "s1", userId: "u1", profileId: "p1", productKey: "compute",
      productName: "算力设备出租", journeyStage: "evaluating", sentiment: "neutral",
      satisfaction: "unknown", health: "healthy", needs: ["算力设备出租"],
      objections: ["对价格敏感"], currentIssues: [], manualLockFields: [],
    });

    const params = query.mock.calls[0][1] as unknown[];
    expect(params[9]).toBe('["算力设备出租"]');
    expect(params[10]).toBe('["对价格敏感"]');
    expect(params[11]).toBe("[]");
  });

  it("persists the cohort summary generation method for audit", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = new DigitalEmployeeRepository({ query } as any);

    await repository.upsertCohortSnapshot("u1", {
      snapshotDate: "2026-08-18",
      summary: "客户整体保持活跃。",
      metrics: {
        totalProfiles: 3, activeLast7Days: 2, dueFollowUps: 1,
        relationshipStages: [], health: [], topTags: [],
      },
      generatedAt: "2026-08-18T15:00:00.000Z",
      generationMethod: "llm",
      modelId: "llm-primary",
    });

    expect(query.mock.calls[0][0] as string).toContain("generation_method");
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining(["llm", "llm-primary"]));
  });
});
