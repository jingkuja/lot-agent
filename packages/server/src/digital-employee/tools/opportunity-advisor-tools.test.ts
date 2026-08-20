import { describe, expect, it, vi } from "vitest";
import { createOpportunityAdvisorTools } from "./opportunity-advisor-tools.js";

function find(name: string, service: Record<string, unknown>) {
  return createOpportunityAdvisorTools(service as any).find((tool) => tool.name === name)!;
}

const context = {
  userId: "u1",
  workingDirectory: "/tmp",
  featureScope: "opportunity-advisor",
  conversationId: "c1",
};

describe("opportunity advisor agent tools", () => {
  it("exposes the single-customer work queue, action and outreach tools", () => {
    const names = createOpportunityAdvisorTools({ opportunities: {} } as any).map((tool) => tool.name);
    expect(names).toEqual([
      "search_customer_work_queue",
      "search_customer_opportunities",
      "get_customer_business_context",
      "prepare_follow_up_action",
      "commit_follow_up_action",
      "prepare_follow_up_result",
      "commit_follow_up_result",
      "generate_individual_outreach",
      "rewrite_individual_outreach",
      "mark_individual_outreach_used",
    ]);
  });

  it("queries today's personal work queue without exposing contact fields", async () => {
    const list = vi.fn(async () => ({
      summary: { highPriority: 1, dueToday: 1, overdue: 0, awaitingResult: 0 },
      total: 1,
      hasProfiles: true,
      items: [{
        id: "a1", view: "today", opportunityId: "o1", actionId: "a1", profileId: "p1",
        customerName: "李静", organization: "星海", relationshipStage: "prospect",
        opportunityType: "prospect_progress", source: "manual", title: "周四回访",
        objective: "确认演示", followUpMethod: "微信", scheduledAt: "2026-08-20T01:00:00.000Z",
        priority: "high", reason: "已约定", readiness: "actionable", status: "pending",
        overdue: false, productName: "边缘算力",
      }],
    }));
    const result = await find("search_customer_work_queue", { opportunities: { list } }).execute({ view: "today" }, context);
    expect(list).toHaveBeenCalledWith("u1", expect.objectContaining({ view: "today" }));
    const body = JSON.parse(result.content);
    expect(body.items[0]).toMatchObject({ customerName: "李静", title: "周四回访" });
    expect(JSON.stringify(body)).not.toMatch(/phone|email|contact/i);
  });

  it("rejects advisor tools outside the opportunity feature scope", async () => {
    const list = vi.fn();
    const result = await find("search_customer_work_queue", { opportunities: { list } }).execute(
      {},
      { ...context, featureScope: "customer-acquisition" }
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("不在商机参谋作用域");
    expect(list).not.toHaveBeenCalled();
  });

  it("prepares a follow-up action and asks the user to confirm before commit", async () => {
    const prepareFollowUpAction = vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000111",
      question: "确认为「李静」创建跟进「周四回访」？",
      options: ["确认创建", "取消"],
      preview: { customerName: "李静", title: "周四回访" },
    }));
    const resolveCustomerCandidates = vi.fn(async () => [{ id: "00000000-0000-4000-8000-000000000001", displayName: "李静" }]);
    const result = await find("prepare_follow_up_action", {
      opportunities: { prepareFollowUpAction },
      resolveCustomerCandidates,
    }).execute({
      operation: "create",
      customerMention: "李静",
      opportunityType: "prospect_progress",
      title: "周四回访",
      objective: "确认演示时间",
      priority: "high",
      scheduledAt: "2026-08-21T02:00:00.000Z",
    }, context);
    expect(prepareFollowUpAction).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ operation: "create", profileId: "00000000-0000-4000-8000-000000000001" }),
      expect.objectContaining({ conversationId: "c1" })
    );
    expect(result.content).toContain("commit_follow_up_action");
    expect(result.content).toContain("ask_user");
  });

  it("saves generated outreach onto the selected customer action", async () => {
    const generateOutreach = vi.fn(async () => ({
      id: "d1", profileId: "p1", taskId: "a1", content: "李静，周四方便演示吗？", version: 1, usedAt: null,
    }));
    const result = await find("generate_individual_outreach", { opportunities: { generateOutreach } }).execute({
      itemId: "00000000-0000-4000-8000-000000000002",
      intent: "follow_up",
      channel: "wechat",
      message: "生成一条不强推销的微信跟进",
    }, context);
    expect(generateOutreach).toHaveBeenCalledWith("u1", expect.objectContaining({
      itemId: "00000000-0000-4000-8000-000000000002",
      channel: "wechat",
    }));
    expect(JSON.parse(result.content).outreach.content).toContain("周四");
  });
});
