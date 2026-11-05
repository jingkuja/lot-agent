import { describe, expect, it, vi } from "vitest";
import { ProposalService } from "./proposal-service.js";

const created = new Date("2026-11-05T01:00:00Z");
const expires = new Date("2026-11-12T01:00:00Z");
const draftRow = (over: Record<string, unknown> = {}) => ({
  id: "d1", user_id: "u1", conversation_id: "c1", feature_scope: "employee", kind: "marketing_campaign", payload: {},
  preview: { name: "双十一" }, question: "确认？", options: [], status: "awaiting_confirmation", created_at: created, expires_at: expires, ...over,
});

function build(query: (sql: string, params?: unknown[]) => unknown) {
  const opportunities = {
    commitFollowUpAction: vi.fn(async () => ({ alreadyApplied: false, entityId: "a1", managementUrl: "/t" })),
    commitFollowUpResult: vi.fn(),
  };
  const acquisition = {
    commitCustomerSegment: vi.fn(), commitMarketingCampaign: vi.fn(async () => ({ alreadyApplied: false, entityId: "c9", managementUrl: "/m" })),
    commitAssetDeployment: vi.fn(), commitDeploymentFeedback: vi.fn(), commitCampaignResult: vi.fn(),
  };
  const service = new ProposalService(
    { query: vi.fn(async (sql: string, params?: unknown[]) => query(sql, params) ?? { rows: [] }) } as any,
    opportunities as any,
    acquisition as any
  );
  return { service, opportunities, acquisition };
}

describe("ProposalService", () => {
  it("dispatches by the kind stored on the draft", async () => {
    const { service, acquisition } = build((sql) => sql.includes("SELECT * FROM de_conversation_action_drafts") ? { rows: [draftRow()] } : undefined);
    await expect(service.confirm("u1", "d1")).resolves.toEqual({
      id: "d1", kind: "marketing_campaign", alreadyApplied: false, entityId: "c9", managementUrl: "/m",
    });
    expect(acquisition.commitMarketingCampaign).toHaveBeenCalledWith("u1", "d1");
  });

  it("passes on that a commit had already been applied", async () => {
    const { service, acquisition } = build((sql) => sql.includes("SELECT * FROM de_conversation_action_drafts") ? { rows: [draftRow()] } : undefined);
    acquisition.commitMarketingCampaign.mockResolvedValue({ alreadyApplied: true, entityId: "c9", managementUrl: "/m" });
    await expect(service.confirm("u1", "d1")).resolves.toMatchObject({ alreadyApplied: true });
  });

  it("sends customer records back to the conversation", async () => {
    const { service } = build((sql) => sql.includes("SELECT 1 FROM de_customer_capture_drafts") ? { rows: [{}] } : undefined);
    await expect(service.confirm("u1", "d1")).rejects.toThrow("对话里选择");
  });

  it("hides another account's draft", async () => {
    const seen: unknown[][] = [];
    const { service } = build((_sql, params) => { seen.push(params ?? []); return undefined; });
    await expect(service.confirm("u2", "d1")).rejects.toThrow("未找到");
    await expect(service.dismiss("u2", "d1")).rejects.toThrow("未找到");
    expect(seen.every((params) => params.includes("u2"))).toBe(true);
  });

  it("refuses to confirm a kind it does not know", async () => {
    const { service } = build((sql) => sql.includes("SELECT * FROM de_conversation_action_drafts") ? { rows: [draftRow({ kind: "unknown" })] } : undefined);
    await expect(service.confirm("u1", "d1")).rejects.toThrow("对话里选择");
  });

  it("dismisses twice without an error", async () => {
    const { service } = build((sql) => sql.includes("SELECT * FROM") ? { rows: [draftRow({ status: "dismissed" })] } : undefined);
    await expect(service.dismiss("u1", "d1")).resolves.toEqual({ id: "d1", status: "dismissed" });
  });

  it("will not dismiss what was already confirmed", async () => {
    const { service } = build((sql) => sql.includes("SELECT * FROM") ? { rows: [draftRow({ status: "applied" })] } : undefined);
    await expect(service.dismiss("u1", "d1")).rejects.toThrow("已经确认");
  });

  it("dismisses a customer record in its own table", async () => {
    const { service } = build((sql) => sql.startsWith("UPDATE de_customer_capture_drafts") ? { rows: [{ id: "d1" }] } : undefined);
    await expect(service.dismiss("u1", "d1")).resolves.toEqual({ id: "d1", status: "dismissed" });
  });

  it("lists all three draft tables and marks which need a choice", async () => {
    const { service } = build((sql) => {
      if (sql.includes("FROM de_conversation_action_drafts")) return { rows: [draftRow(), draftRow({ id: "d2", kind: "retired_kind" })] };
      if (sql.includes("FROM de_customer_capture_drafts")) return { rows: [{
        id: "d3", conversation_id: "c2", raw_text: "x".repeat(300), ambiguities: ["identity"],
        proposed_observation: { capture: { customerMention: "李静" } }, created_at: expires, expires_at: expires,
      }] };
      if (sql.includes("FROM de_customer_profile_change_drafts")) return { rows: [{
        id: "d4", conversation_id: null, operation: "update", customer_mention: "王总", proposed_patch: { displayName: "王" }, risks: ["high_impact_field"],
        created_at: created, expires_at: expires,
      }] };
      return undefined;
    });
    const items = await service.listPending("u1");
    expect(items.map((item) => [item.id, item.confirmable])).toEqual([["d3", false], ["d1", true], ["d4", false]]);
    expect(items[0].preview).toMatchObject({ customerMention: "李静" });
    expect(String(items[0].preview.excerpt)).toHaveLength(200);
    expect(items[2].preview).toMatchObject({ fields: ["displayName"], risks: ["high_impact_field"] });
  });
});
