import { describe, expect, it, vi } from "vitest";
import { OpportunityService } from "./opportunity-service.js";

describe("OpportunityService settings", () => {
  it("uses consistent explicit parameter types when saving settings", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        enabled: true,
        timezone: "Asia/Shanghai",
        daily_run_time: "09:30:00",
        next_run_at: null,
        last_run_at: null,
        version: 1,
      }],
    }));
    const service = new OpportunityService({ pool: { query } } as any);

    await service.saveSettings("u1", {
      enabled: true,
      timezone: "Asia/Shanghai",
      dailyRunTime: "09:30",
      version: 0,
    });

    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("$2::boolean");
    expect(sql).toContain("$3::text");
    expect(sql).toContain("$4::time");
    expect(query).toHaveBeenCalledWith(expect.any(String), ["u1", true, "Asia/Shanghai", "09:30", 0]);
  });
});

describe("OpportunityService personal work queue", () => {
  it("builds the today view from due actions and pending results", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_automation_settings")) return { rows: [] };
      if (sql.includes("FROM de_follow_up_suggestion_runs")) return { rows: [] };
      if (sql.includes("count(*)::int AS count FROM de_customer_profiles")) return { rows: [{ count: 1 }] };
      if (sql.includes("AS high_priority")) return { rows: [{ high_priority: 0, due_today: 0, overdue: 0, awaiting_result: 0 }] };
      return { rows: [] };
    });
    const service = new OpportunityService({ pool: { query } } as any);

    await service.list("u1", { view: "today" });

    const workQueueSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("FROM de_follow_up_tasks task")) ?? "";
    expect(workQueueSql).toContain("task.scheduled_at < date_trunc('day', now()) + interval '1 day'");
    expect(workQueueSql).toContain("task.status = 'awaiting_result'");
  });

  it("accepts a personal opportunity without creating an acquisition content project", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_suggestions suggestion")) {
        return { rows: [{
          id: "o1", status: "suggested", profile_id: "p1", display_name: "李静", organization: "星海科技",
          relationship_stage: "prospect", title: "预约演示", objective: "确认演示时间", follow_up_method: "企微/微信",
          suggested_at: "2026-08-20T01:00:00.000Z", priority: "high", risk_flags: [], opportunity_type: "prospect_progress",
          product_key: "edge", product_name: "边缘算力",
        }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const service = new OpportunityService({ pool: { connect: vi.fn(async () => client) } } as any);

    const result = await service.decide("u1", "o1", { decision: "accept" });

    expect(result).toMatchObject({ opportunityId: "o1", status: "accepted" });
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes("de_copy_projects"))).toBe(false);
  });

  it("generates a conversational talk track from the selected customer context", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_tasks task")) return { rows: [{
        id: "o1", action_id: "a1", profile_id: "p1", action_status: "pending", action_source: "manual",
        display_name: "李姐", organization: "星海科技", relationship_stage: "prospect",
        opportunity_type: "prospect_progress", title: "推进服务签约", objective: "确认合同反馈",
        follow_up_method: "企微/微信", suggested_at: "2026-08-18T01:00:00.000Z",
        scheduled_at: "2026-08-20T01:00:00.000Z", priority: "normal", reason: "客户正在评估合同",
        evidence: [], readiness: "actionable", risk_flags: [], product_name: "机房运维服务",
        result_criteria: "获得明确回复", action_version: 1,
      }] };
      if (sql.includes("AS product_states")) return { rows: [{
        summary: "关注交付稳定性", tags: ["重点客户"],
        product_states: [{ productName: "机房运维服务", journeyStage: "evaluating" }],
        recent_facts: [{ text: "客户要求先发合同模板", occurredAt: "2026-08-18T02:00:00.000Z" }],
      }] };
      if (sql.includes("FROM marketing_products")) return { rows: [{
        name: "机房运维服务", positioning: "稳定运维", prohibited_expressions: ["绝对零故障"],
      }] };
      return { rows: [] };
    });
    const generate = vi.fn(async () => ({ modelId: "test-model", reply: "李姐，合同模板您看得怎么样？" }));
    const service = new OpportunityService({ pool: { query } } as any, undefined, undefined, { generate });

    const result = await service.generateTalkTrack("u1", "a1", {
      intent: "follow_up", message: "生成微信跟进话术", history: [],
    });

    expect(result).toEqual({ modelId: "test-model", reply: "李姐，合同模板您看得怎么样？" });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      context: expect.objectContaining({
        customerName: "李姐", productName: "机房运维服务",
        recentFacts: [{ text: "客户要求先发合同模板", occurredAt: "2026-08-18T02:00:00.000Z" }],
      }),
    }));
  });
});
