import { describe, expect, it, vi } from "vitest";
import { TodayService } from "./today-service.js";

const work = (over: Record<string, unknown>) => ({
  id: "w1", opportunityId: "o1", actionId: "a1", actionVersion: 2, profileId: "p1", customerName: "李静", title: "回访", reason: "问了代销",
  evidence: [{ fact: "嫌门槛高" }], priority: "normal", overdue: false, scheduledAt: "2026-11-05T02:00:00.000Z", status: "pending", ...over,
});
const list = (items: unknown[] = []) => ({ items, hasProfiles: true, lastDiscoveredAt: "2026-11-05T00:00:00.000Z" });

function build(views: Record<string, unknown[]> = {}, extra: {
  recommendations?: unknown[]; proposals?: unknown[]; tasks?: unknown[]; deployments?: unknown[]; brief?: unknown;
} = {}) {
  const opportunities = { list: vi.fn(async (_userId: string, filters: { view: string }) => list(views[filters.view])) };
  const acquisition = {
    listRecommendations: vi.fn(async () => ({ items: extra.recommendations ?? [], generatedAt: null })),
    listDeploymentsAwaitingFeedback: vi.fn(async () => extra.deployments ?? []),
  };
  const proposals = { listPending: vi.fn(async () => extra.proposals ?? []) };
  const settings = { get: vi.fn(async () => ({ employeeName: "阿灵", feishuReminder: false, desktopReminder: true, version: 1 })) };
  const briefs = { latest: vi.fn(async () => extra.brief ?? null) };
  const query = vi.fn(async () => ({ rows: extra.tasks ?? [] }));
  return {
    service: new TodayService({ query } as any, settings, opportunities as any, acquisition as any, proposals as any, briefs as any),
    opportunities, acquisition, proposals, query,
  };
}

describe("TodayService", () => {
  it("turns every source into one kind of work item", async () => {
    const { service } = build({
      today: [work({ id: "t1" }), work({ id: "t2", status: "awaiting_result", actionId: "a2" })],
      pending: [work({ id: "o1", actionId: null, opportunityId: "o1", status: "suggested", scheduledAt: null })],
    }, {
      recommendations: [{ id: "r1", segmentId: "s1", segmentName: "华东潜客", targetSegmentDescription: "华东", theme: "代销说明会", reasoning: ["集中问价"] }],
      proposals: [{
        id: "d1", kind: "follow_up_action", confirmable: true, conversationId: "c1",
        preview: { profileId: "p1", customerName: "李静", title: "明天跟进" }, createdAt: "", expiresAt: "",
      }],
    });
    const { items } = await service.get("u1");
    expect(items.map((item) => [item.kind, item.source.type, item.source.id]).sort()).toEqual([
      ["follow_up", "action", "a1"],
      ["opportunity", "opportunity", "o1"],
      ["proposal", "follow_up_action", "d1"],
      ["recommendation", "recommendation", "r1"],
      ["result", "action", "a2"],
    ]);
    expect(items.find((item) => item.kind === "proposal")?.subject).toEqual({ type: "customer", id: "p1", label: "李静" });
    expect(items.find((item) => item.kind === "recommendation")?.subject).toEqual({ type: "segment", id: "s1", label: "华东潜客" });
  });

  it("names the employee from settings and reports whether there are customers", async () => {
    const { service } = build();
    await expect(service.get("u1")).resolves.toMatchObject({ employee: { name: "阿灵" }, hasProfiles: true, snoozedCount: 0 });
  });

  it("puts overdue work first", async () => {
    const { service } = build({ today: [work({ id: "t1", scheduledAt: "2026-11-05T01:00:00.000Z" }), work({ id: "t2", overdue: true, scheduledAt: "2026-11-05T03:00:00.000Z" })] });
    const { items } = await service.get("u1");
    expect(items[0].id).toBe("follow_up:t2");
    expect(items[0].priority).toBe("high");
  });

  it("asks every source for this account only", async () => {
    const { service, opportunities, acquisition, proposals, query } = build();
    await service.get("u9");
    for (const call of opportunities.list.mock.calls) expect(call[0]).toBe("u9");
    expect(acquisition.listRecommendations).toHaveBeenCalledWith("u9", "pending");
    expect(proposals.listPending).toHaveBeenCalledWith("u9");
    expect(query.mock.calls[0]).toEqual([expect.stringContaining("user_id=$1"), ["u9", 10]]);
  });

  it("reports running work", async () => {
    const { service } = build({}, { tasks: [{
      id: "t1", type: "image.generate", status: "running", progress: "40", stage: null, created_at: new Date("2026-11-05T00:00:00Z"),
    }] });
    const { running } = await service.get("u1");
    expect(running).toEqual([{ id: "t1", type: "image.generate", status: "running", progress: 40, stage: null, createdAt: "2026-11-05T00:00:00.000Z" }]);
  });

  it("caps daily recommendations", async () => {
    const recommendations = Array.from({ length: 9 }, (_, index) => ({
      id: `r${index}`,
      segmentId: null,
      targetSegmentDescription: "",
      theme: "t",
      reasoning: [],
    }));
    const { service } = build({}, { recommendations });
    expect((await service.get("u1")).items).toHaveLength(6);
  });

  it("asks about a publication that has had no feedback", async () => {
    const { service } = build({}, { deployments: [{ id: "dp1", assetId: "as1", title: "双十一海报", platform: "moments", customPlatform: null, deployedAt: "2026-11-01T00:00:00.000Z" }] });
    const { items } = await service.get("u1");
    expect(items).toEqual([expect.objectContaining({
      id: "result:dp1", kind: "result", subject: { type: "asset", id: "as1", label: "双十一海报" }, source: { type: "deployment", id: "dp1" },
    })]);
  });

  it("counts everything waiting on the owner for the brand area", async () => {
    const { service } = build({ today: [work({ id: "t1" })] }, {
      proposals: [{ id: "d1", kind: "campaign_result", preview: {}, confirmable: true, conversationId: null, createdAt: "", expiresAt: "" }],
      brief: { id: "b1", date: "2026-11-05", counts: {}, readAt: null },
    });
    await expect(service.summary("u1")).resolves.toMatchObject({ pending: 2, desktopReminder: true, brief: { id: "b1" } });
  });
});
