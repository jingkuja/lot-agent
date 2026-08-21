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

  it("casts the next-run timestamp so Postgres does not treat Date+$interval as interval", async () => {
    const now = new Date("2026-08-20T01:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_automation_settings")) {
        return { rows: [{ user_id: "u1", timezone: "Asia/Shanghai" }] };
      }
      if (sql.includes("INSERT INTO de_follow_up_suggestion_runs")) {
        return { rows: [{ id: "run-1" }] };
      }
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => "task-1");
    const service = new OpportunityService(
      { pool: { query } } as any,
      { enqueue } as any,
    );

    await service.enqueueDueDiscoveries(now);

    const advanceSql = query.mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes("next_daily_run")) ?? "";
    expect(advanceSql).toContain("$2::timestamptz + interval '1 minute'");
    expect(advanceSql).toContain("timezone::text");
    expect(advanceSql).not.toContain("daily_run_time,$2 + interval");
  });

  it("retries today's failed discovery instead of blocking on the unique daily row", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO de_follow_up_suggestion_runs")) return { rows: [] };
      if (sql.includes("SELECT id, task_id, status FROM de_follow_up_suggestion_runs")) {
        return { rows: [{ id: "run-1", task_id: null, status: "failed" }] };
      }
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => "task-retry");
    const service = new OpportunityService({ pool: { query } } as any, { enqueue } as any);

    const result = await service.requestDiscovery("u1");

    expect(result).toEqual({ runId: "run-1", taskId: "task-retry", reused: false });
    expect(enqueue).toHaveBeenCalledWith("opportunity.discover", { runId: "run-1" }, "u1", { maxAttempts: 2 });
    const relinkSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("SET task_id")) ?? "";
    expect(relinkSql).toContain("status = 'pending'");
    expect(relinkSql).toContain("error_code = NULL");
  });

  it("does not advance next_run_at when daily enqueue fails", async () => {
    const now = new Date("2026-08-20T01:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_automation_settings")) {
        return { rows: [{ user_id: "u1", timezone: "Asia/Shanghai" }] };
      }
      if (sql.includes("INSERT INTO de_follow_up_suggestion_runs")) {
        return { rows: [{ id: "run-1" }] };
      }
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => { throw new Error("redis down"); });
    const service = new OpportunityService({ pool: { query } } as any, { enqueue } as any);

    await expect(service.enqueueDueDiscoveries(now)).resolves.toBe(0);

    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((item) => item.includes("error_code = 'enqueue_failed'"))).toBe(true);
    expect(sql.some((item) => item.includes("next_daily_run"))).toBe(false);
  });

  it("retries a same-day enqueue_failed run on the next scan without skipping the schedule", async () => {
    const now = new Date("2026-08-20T01:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_automation_settings") && sql.includes("next_run_at")) {
        return { rows: [{ user_id: "u1", timezone: "Asia/Shanghai" }] };
      }
      if (sql.includes("INSERT INTO de_follow_up_suggestion_runs")) return { rows: [] };
      if (sql.includes("SELECT id, task_id, status FROM de_follow_up_suggestion_runs")) {
        return { rows: [{ id: "run-1", task_id: null, status: "failed" }] };
      }
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => "task-2");
    const service = new OpportunityService({ pool: { query } } as any, { enqueue } as any);

    await expect(service.enqueueDueDiscoveries(now)).resolves.toBe(1);
    expect(enqueue).toHaveBeenCalledWith("opportunity.discover", { runId: "run-1" }, "u1", { maxAttempts: 2 });
    expect(query.mock.calls.some((call) => String(call[0]).includes("next_daily_run"))).toBe(true);
  });

  it("advances the schedule for an already queued same-day run without enqueueing again", async () => {
    const now = new Date("2026-08-20T01:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_automation_settings") && sql.includes("next_run_at")) {
        return { rows: [{ user_id: "u1", timezone: "Asia/Shanghai" }] };
      }
      if (sql.includes("INSERT INTO de_follow_up_suggestion_runs")) return { rows: [] };
      if (sql.includes("SELECT id, task_id, status FROM de_follow_up_suggestion_runs")) {
        return { rows: [{ id: "run-1", task_id: "task-1", status: "succeeded" }] };
      }
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => "task-new");
    const service = new OpportunityService({ pool: { query } } as any, { enqueue } as any);

    await expect(service.enqueueDueDiscoveries(now)).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(query.mock.calls.some((call) => String(call[0]).includes("next_daily_run"))).toBe(true);
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
    expect(workQueueSql).toContain("profile.status = 'active'");
    const summarySql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("AS high_priority")) ?? "";
    expect(summarySql).toContain("profile.status = 'active'");
  });

  it("cancels open tasks and dismisses suggestions when a profile is archived", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const service = new OpportunityService({ pool: { query } } as any);
    await service.cancelOpenWorkForProfile("u1", "p1");
    const sql = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).toContain("close_reason = 'profile_archived'");
    expect(sql).toContain("status = 'dismissed'");
    expect(sql).toContain("decision_reason = 'profile_archived'");
  });

  it("excludes archived customers from the pending suggestion queue", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_automation_settings")) return { rows: [] };
      if (sql.includes("FROM de_follow_up_suggestion_runs")) return { rows: [] };
      if (sql.includes("count(*)::int AS count FROM de_customer_profiles")) return { rows: [{ count: 1 }] };
      if (sql.includes("AS high_priority")) return { rows: [{ high_priority: 0, due_today: 0, overdue: 0, awaiting_result: 0 }] };
      return { rows: [] };
    });
    const service = new OpportunityService({ pool: { query } } as any);
    await service.list("u1", { view: "pending" });
    const pendingSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("suggestion.status = 'suggested'")) ?? "";
    expect(pendingSql).toContain("profile.status = 'active'");
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

  it("persists generated outreach against the selected customer", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_tasks task")) return { rows: [{
        id: "o1", action_id: "a1", profile_id: "p1", action_status: "pending", action_source: "manual",
        display_name: "李静", organization: null, relationship_stage: "prospect",
        opportunity_type: "prospect_progress", title: "回访", objective: "确认演示",
        follow_up_method: "微信", suggested_at: "2026-08-18T01:00:00.000Z",
        scheduled_at: "2026-08-20T01:00:00.000Z", priority: "normal", reason: "约定回访",
        evidence: [], readiness: "actionable", risk_flags: [], product_name: null,
        result_criteria: null, action_version: 1,
      }] };
      if (sql.includes("AS product_states")) return { rows: [{ summary: "", tags: [], product_states: [], recent_facts: [] }] };
      if (sql.includes("INSERT INTO de_outreach_drafts")) return { rows: [{
        id: "d1", profile_id: "p1", task_id: "a1", opportunity_id: "o1", channel: "wechat",
        objective: "确认演示", content: "李静，周四方便吗？", version: 1, used_at: null, model_id: "m1",
      }] };
      return { rows: [] };
    });
    const service = new OpportunityService(
      { pool: { query } } as any,
      undefined,
      undefined,
      { generate: vi.fn(async () => ({ modelId: "m1", reply: "李静，周四方便吗？" })) },
    );

    const result = await service.generateOutreach("u1", {
      itemId: "a1", intent: "follow_up", channel: "wechat", message: "生成微信回访",
    });

    expect(result).toMatchObject({ profileId: "p1", taskId: "a1", content: "李静，周四方便吗？" });
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO de_outreach_drafts"))).toBe(true);
  });

  it("writes a contact observation and refreshes profile cadence when a result is recorded", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_follow_up_tasks WHERE id")) {
        return { rows: [{
          id: "a1", user_id: "u1", profile_id: "p1", status: "awaiting_result",
          executed_at: "2026-08-20T04:00:00.000Z", follow_up_method: "企微/微信",
          product_key: "edge", product_name: "边缘算力", priority: "normal",
        }] };
      }
      if (sql.includes("INSERT INTO de_customer_observations")) return { rows: [{ id: "obs1" }] };
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const service = new OpportunityService({ pool: { connect: vi.fn(async () => client) } } as any);

    const result = await service.addResult("u1", "a1", {
      outcome: "scheduled",
      customerQuote: "周四可以演示",
      nextAction: "安排演示",
      nextActionAt: "2026-08-21T02:00:00.000Z",
    });

    expect(result).toMatchObject({ actionId: "a1", status: "completed" });
    const sql = clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).toContain("INSERT INTO de_customer_observations");
    expect(sql).toContain("INSERT INTO de_customer_observation_extractions");
    expect(sql).toContain("last_contact_at");
    expect(sql).toContain("next_follow_up_at");
    expect(sql).toContain("last_observed_at");
    const observationCall = clientQuery.mock.calls.find((call) => String(call[0]).includes("INSERT INTO de_customer_observations"));
    expect(observationCall?.[1]?.[5]).toContain("周四可以演示");
    const cadenceCall = clientQuery.mock.calls.find((call) => String(call[0]).includes("next_follow_up_at"));
    expect(cadenceCall?.[1]).toEqual(["u1", "p1", "2026-08-20T04:00:00.000Z"]);
    const extractionCall = clientQuery.mock.calls.find((call) => String(call[0]).includes("INSERT INTO de_customer_observation_extractions"));
    expect(extractionCall?.[1]?.[4]).toBe("contact");
  });

  it("marks last contact when an action is executed, even before the result is filled in", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("RETURNING *") && sql.includes("executed_at")) {
        return { rows: [{ id: "a1", profile_id: "p1", executed_at: "2026-08-20T05:00:00.000Z" }] };
      }
      if (sql.includes("FROM de_follow_up_tasks task")) return { rows: [{
        id: "o1", action_id: "a1", profile_id: "p1", action_status: "awaiting_result", action_source: "manual",
        display_name: "李静", organization: null, relationship_stage: "prospect",
        opportunity_type: "prospect_progress", title: "回访", objective: "确认演示",
        follow_up_method: "微信", suggested_at: "2026-08-18T01:00:00.000Z",
        scheduled_at: "2026-08-20T01:00:00.000Z", priority: "normal", reason: "约定回访",
        evidence: [], readiness: "actionable", risk_flags: [], product_name: null,
        result_criteria: null, action_version: 2,
      }] };
      return { rows: [] };
    });
    const service = new OpportunityService({ pool: { query } } as any);
    await service.updateAction("u1", "a1", { operation: "execute", version: 1 });
    const cadenceSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("last_contact_at")) ?? "";
    expect(cadenceSql).toContain("last_contact_at");
    expect(cadenceSql).toContain("next_follow_up_at");
    const cadenceArgs = query.mock.calls.find((call) => String(call[0]).includes("last_contact_at"))?.[1];
    expect(cadenceArgs).toEqual(["u1", "p1", "2026-08-20T05:00:00.000Z"]);
  });
});
