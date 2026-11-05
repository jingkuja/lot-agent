import { describe, expect, it, vi } from "vitest";
import { collectTemplate, parseScheduleReport } from "./schedule-templates.js";

describe("parseScheduleReport", () => {
  it("reads a report, fenced or not", () => {
    expect(parseScheduleReport('```json\n{"summary":"好","items":[{"title":"a","body":"b"},{"title":"","body":"x"}],"question":null}\n```'))
      .toEqual({ summary: "好", items: [{ title: "a", body: "b" }], question: null });
  });

  it("fails a run that returned no report", () => {
    expect(() => parseScheduleReport('{"items":[]}')).toThrow();
    expect(() => parseScheduleReport("sorry")).toThrow();
  });
});

describe("collectTemplate", () => {
  const item = (over = {}) => ({
    customerName: "李静", organization: "星河", title: "回访", objective: "确认门槛", followUpMethod: "微信", reason: "问了价格", overdue: false, status: "pending",
    evidence: [{ fact: "嫌门槛高" }, { fact: "手机 13812345678" }], ...over,
  });

  it("keeps contact details out of what the model sees", async () => {
    const list = vi.fn(async () => ({ items: [item()] }));
    const query = vi.fn(async () => ({ rows: [{ name: "代销方案", positioning: "轻量", core_values: [], product_notes: "门槛 980 元", prohibited_expressions: ["保证赚钱"] }] }));
    const { data, worthRunning } = await collectTemplate("follow_up_prep", { pool: { query } as never, opportunities: { list } as never }, "u1");
    expect(worthRunning).toBe(true);
    expect(JSON.stringify(data)).toContain("嫌门槛高");
    expect(JSON.stringify(data)).not.toContain("13812345678");
    expect(data).toMatchObject({ products: [{ name: "代销方案", notes: "门槛 980 元", prohibitedExpressions: ["保证赚钱"] }] });
  });

  it("has nothing to do without follow-ups", async () => {
    const list = vi.fn(async () => ({ items: [item({ status: "awaiting_result" })] }));
    const query = vi.fn();
    expect((await collectTemplate("follow_up_prep", { pool: { query } as never, opportunities: { list } as never }, "u1")).worthRunning).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("gives the weekly review totals only", async () => {
    const counts = { customers: 3, new_customers: 1, notes: 2 };
    const query = vi.fn(async () => ({ rows: [counts] }));
    const input = await collectTemplate("weekly_review", { pool: { query } as never, opportunities: { list: vi.fn() } as never }, "u1");
    expect(input).toMatchObject({ worthRunning: true, data: counts });
    expect(query.mock.calls[0]).toEqual([expect.not.stringContaining("display_name"), ["u1"]]);
  });
});
