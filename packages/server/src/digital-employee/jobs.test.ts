import { afterEach, describe, expect, it, vi } from "vitest";
import { createDailyScanFollowUp, deliverBriefs, registerDigitalEmployeeWorkerJobs } from "./jobs.js";
import { OpportunityService } from "./opportunity-service.js";

const counts = { scanned: 1, created: 0, confirm: 1, followUps: 0, results: 0, pending: 1 };

function delivery(claimed: unknown[]) {
  return {
    briefs: { claimFeishuDeliveries: vi.fn(async () => claimed), markDelivered: vi.fn(async () => undefined) },
    settings: { get: vi.fn(async () => ({ employeeName: "小灵" })) },
  };
}

describe("brief delivery", () => {
  afterEach(() => vi.unstubAllEnvs());
  const on = () => { vi.stubEnv("DIGITAL_EMPLOYEE_WORKSPACE", "1"); vi.stubEnv("DIGITAL_EMPLOYEE_DAILY_SCAN", "1"); };

  it("sends once per account and day, keyed so a restart cannot send again", async () => {
    on();
    const service = delivery([{ id: "b1", userId: "u1", date: "2026-11-05", counts }]);
    const sendToOwner = vi.fn(async () => undefined);
    await deliverBriefs(service as any, { sendToOwner, english: false });
    expect(sendToOwner).toHaveBeenCalledWith("u1", { text: expect.stringContaining("待确认 1 件"), requestId: "employee-brief:u1:2026-11-05" });
    expect(service.briefs.markDelivered).toHaveBeenCalledWith("b1");
  });

  it("leaves a failed send undelivered without stopping the others", async () => {
    on();
    const service = delivery([{ id: "b1", userId: "u1", date: "d", counts }, { id: "b2", userId: "u2", date: "d", counts }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sendToOwner = vi.fn(async (userId: string) => { if (userId === "u1") throw new Error("no connection"); });
    await deliverBriefs(service as any, { sendToOwner, english: false });
    expect(service.briefs.markDelivered.mock.calls).toEqual([["b2"]]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([["the switch is off", () => {}], ["Feishu is not configured", on]])("does nothing when %s", async (_label, setup) => {
    setup();
    const service = delivery([]);
    await deliverBriefs(service as any, { sendToOwner: _label === "the switch is off" ? vi.fn() : undefined, english: false });
    expect(service.briefs.claimFeishuDeliveries).not.toHaveBeenCalled();
  });
});

describe("worker job", () => {
  function worker() {
    const handlers = new Map<string, (job: any) => Promise<unknown>>();
    const queue = { process: vi.fn((name: string, handler: any) => handlers.set(name, handler)), updateProgress: vi.fn(async () => undefined) };
    return { queue, run: (input: unknown) => handlers.get("opportunity.discover")!({ id: "t1", userId: "u1", input }) };
  }

  it("skips the brief for a manual run", async () => {
    const runDiscovery = vi.spyOn(OpportunityService.prototype, "runDiscovery").mockResolvedValue({ runId: "r1", status: "succeeded", created: 0 });
    const query = vi.fn(async () => ({ rows: [] }));
    const { queue, run } = worker();
    registerDigitalEmployeeWorkerJobs({ queue: queue as any, db: { pool: { query } } as any, adviceLlm: {} as any });
    await run({ runId: "r1" });
    expect(runDiscovery).toHaveBeenCalledWith("u1", "r1", expect.any(Function), { useModel: undefined });
    expect(query).not.toHaveBeenCalled();
    runDiscovery.mockRestore();
  });

  it("still reports the scan when the brief fails", async () => {
    const runDiscovery = vi.spyOn(OpportunityService.prototype, "runDiscovery").mockResolvedValue({ runId: "r1", status: "succeeded", created: 2 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { queue, run } = worker();
    registerDigitalEmployeeWorkerJobs({
      queue: queue as any, db: { pool: { query: vi.fn(async () => { throw new Error("db"); }) } } as any, adviceLlm: {} as any,
    });
    await expect(run({ runId: "r1", daily: true, useModel: false })).resolves.toMatchObject({ created: 2 });
    expect(runDiscovery).toHaveBeenCalledWith("u1", "r1", expect.any(Function), { useModel: false });
    expect(warn).toHaveBeenCalled();
    runDiscovery.mockRestore();
    warn.mockRestore();
  });

  it("follows a scan with rule recommendations and no generator to call", async () => {
    const seeded: string[] = [];
    const query = vi.fn(async (sql: string) => {
      seeded.push(sql);
      if (sql.includes("AS recent")) return { rows: [{ recent: true, has_product: true }] };
      return { rows: [] };
    });
    const opportunities = { list: vi.fn(async () => ({ items: [], hasProfiles: true, lastDiscoveredAt: null })) };
    await createDailyScanFollowUp({ pool: { query } } as any, opportunities as any)("u1", { scanned: 3, created: 1 });
    const brief = seeded.findIndex((sql) => sql.includes("INSERT INTO de_employee_briefs"));
    expect(brief).toBeGreaterThan(-1);
    expect(query.mock.calls[brief]).toEqual([expect.any(String), expect.arrayContaining(["u1", expect.stringContaining('"scanned":3')])]);
    expect(seeded.some((sql) => sql.includes("INSERT INTO de_daily_recommendations"))).toBe(false);
  });
});
