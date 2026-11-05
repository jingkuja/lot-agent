import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretBox } from "../auth/secret-box.js";
import { DB } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import { ScheduleService, type ScheduleExecution } from "./schedule-service.js";
import { DigitalEmployeeService } from "./service.js";

// Explicit opt-in; never use DATABASE_URL or the application's configured database.
const testUrl = process.env.DIGITAL_EMPLOYEE_SCHEDULE_TEST_DATABASE_URL;

const DAILY = { kind: "daily", hour: 9, minute: 0 } as const;
const TZ = "Asia/Shanghai";
// 09:00:30 in Shanghai on the day each schedule falls due.
const DUE = new Date("2026-11-05T01:00:30.000Z");
const REPORT = { summary: "今天 1 位客户要跟进", items: [{ title: "李静", body: "先问门槛顾虑" }], question: null };

describe.skipIf(!testUrl)("digital employee schedules on PostgreSQL", () => {
  let db: DB;
  let service: DigitalEmployeeService;
  let schedules: ScheduleService;
  const enqueue = vi.fn(async () => randomUUID());
  const generate = vi.fn<ScheduleExecution["generate"]>(async () => ({ report: REPORT, modelId: "deepseek-v4.1-flash" }));
  const checkQuota = vi.fn(async () => ({ ok: true }));

  const execution = (): ScheduleExecution => ({ opportunities: service.opportunities, checkQuota, generate });
  const owner = () => `owner-${randomUUID()}`;
  const runsOf = async (userId: string) => (await db.pool.query(
    `SELECT id, status, reason, report, scheduled_for FROM de_employee_schedule_runs WHERE user_id=$1 ORDER BY created_at`, [userId]
  )).rows;
  const due = async (userId: string, at = new Date(DUE.getTime() - 30_000), template = "follow_up_prep") => {
    const input = { template: template as never, timing: DAILY, timezone: TZ, enabled: true };
    const { id } = await schedules.create(userId, input, new Date(at.getTime() - 3_600_000));
    await db.pool.query(`UPDATE de_employee_schedules SET next_run_at=$2 WHERE id=$1`, [id, at]);
    return id;
  };
  /** A customer with a follow-up due now, so the template has something to do. */
  const withFollowUp = async (userId: string) => {
    const { profile } = await service.createProfile(userId, { displayName: "李静", relationshipStage: "customer" });
    await db.pool.query(
      `INSERT INTO de_follow_up_tasks (id, user_id, owner_user_id, profile_id, source, title, objective, follow_up_method, priority, status, scheduled_at, opportunity_type)
       VALUES ($1,$2,$2,$3,'manual','回访李静','确认门槛','微信','normal','pending',now() - interval '1 hour','manual_follow_up')`,
      [randomUUID(), userId, profile.id]
    );
  };

  beforeAll(async () => {
    process.env.DIGITAL_EMPLOYEE_SCHEDULES = "1";
    const url = new URL(testUrl!);
    if (!/^\/lot_de_schedule_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Requires a dedicated lot_de_schedule_test_* database");
    db = new DB({
      host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: url.pathname.slice(1),
    }, new SecretBox(undefined));
    const { rows } = await db.pool.query("SELECT to_regclass('public.conversations') AS existing");
    if (rows[0].existing) throw new Error("Test database must be empty; refusing to modify existing data");
    await runMigrations(db.pool, migrations);
    service = new DigitalEmployeeService(db, new SecretBox(undefined));
    schedules = new ScheduleService(db.pool, { enqueue });
  });
  afterAll(async () => {
    delete process.env.DIGITAL_EMPLOYEE_SCHEDULES;
    await db?.pool.end();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.pool.query(`DELETE FROM de_employee_schedule_runs`);
    await db.pool.query(`DELETE FROM de_employee_schedules`);
  });

  it("queues a due schedule once and moves it to the next occurrence", async () => {
    const userId = owner();
    const id = await due(userId);
    expect(await schedules.dispatchDue(DUE)).toBe(1);
    expect(await schedules.dispatchDue(DUE)).toBe(0);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]).toEqual(["employee.schedule.run", { runId: expect.any(String) }, userId, expect.objectContaining({ maxAttempts: 1 })]);
    const { rows: [row] } = await db.pool.query(`SELECT next_run_at FROM de_employee_schedules WHERE id=$1`, [id]);
    expect(row.next_run_at.toISOString()).toBe("2026-11-06T01:00:00.000Z");
    expect(await runsOf(userId)).toMatchObject([{ status: "queued" }]);
  });

  it("records a missed run without running it", async () => {
    const userId = owner();
    await due(userId, new Date(DUE.getTime() - 3_600_000));
    expect(await schedules.dispatchDue(DUE)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await runsOf(userId)).toMatchObject([{ status: "missed", reason: null }]);
  });

  it("skips while the previous run has not finished", async () => {
    const userId = owner();
    const id = await due(userId);
    await schedules.dispatchDue(DUE);
    await db.pool.query(`UPDATE de_employee_schedules SET next_run_at=$2 WHERE id=$1`, [id, new Date(DUE.getTime() + 60_000)]);
    await schedules.dispatchDue(new Date(DUE.getTime() + 61_000));
    expect(enqueue).toHaveBeenCalledOnce();
    expect(await runsOf(userId)).toMatchObject([{ status: "queued" }, { status: "skipped", reason: "overlap" }]);
  });

  it("runs a template at most twice a day across schedules", async () => {
    const userId = owner();
    await due(userId); await due(userId); await due(userId);
    await due(userId, new Date(DUE.getTime() - 30_000), "weekly_review");
    expect(await schedules.dispatchDue(DUE)).toBe(3);
    const runs = await runsOf(userId);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(3);
    expect(runs.filter((run) => run.reason === "daily_limit")).toHaveLength(1);
  });

  it("does not count a skipped run against the limit", async () => {
    const userId = owner();
    await due(userId);
    await schedules.dispatchDue(DUE);
    await schedules.execute(userId, (await runsOf(userId))[0].id, execution()); // nothing to do: no customers
    await due(userId); await due(userId);
    expect(await schedules.dispatchDue(DUE)).toBe(2);
  });

  it("turns a one-off off after it fires", async () => {
    const userId = owner();
    const at = new Date(DUE.getTime() - 30_000);
    const input = { template: "weekly_review" as const, timing: { kind: "once" as const, at: at.toISOString() }, timezone: TZ, enabled: true };
    const { id } = await schedules.create(userId, input, new Date(at.getTime() - 60_000));
    await schedules.dispatchDue(DUE);
    const { rows: [row] } = await db.pool.query(`SELECT enabled, next_run_at FROM de_employee_schedules WHERE id=$1`, [id]);
    expect(row).toMatchObject({ enabled: false, next_run_at: null });
  });

  it("marks a run failed when it cannot be queued, and does not try again", async () => {
    const userId = owner();
    await due(userId);
    enqueue.mockRejectedValueOnce(new Error("redis down"));
    expect(await schedules.dispatchDue(DUE)).toBe(0);
    expect(await runsOf(userId)).toMatchObject([{ status: "failed", reason: "enqueue_failed" }]);
    await schedules.dispatchDue(DUE);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("closes a run that lost its worker instead of repeating it", async () => {
    const userId = owner();
    await due(userId);
    await schedules.dispatchDue(DUE);
    await db.pool.query(`UPDATE de_employee_schedule_runs SET created_at = now() - interval '1 hour' WHERE user_id=$1`, [userId]);
    await schedules.dispatchDue(DUE);
    expect(await runsOf(userId)).toMatchObject([{ status: "failed", reason: "abandoned" }]);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("writes a report and changes no business record", async () => {
    const userId = owner();
    await withFollowUp(userId);
    await due(userId);
    await schedules.dispatchDue(DUE);
    const count = async () => (await db.pool.query(
      `SELECT (SELECT count(*) FROM de_follow_up_tasks WHERE user_id=$1)::int tasks, (SELECT count(*) FROM de_customer_observations WHERE user_id=$1)::int notes,
         (SELECT count(*) FROM de_outreach_drafts WHERE user_id=$1)::int drafts, (SELECT count(*) FROM de_marketing_asset_library WHERE user_id=$1)::int assets`, [userId]
    )).rows[0];
    const before = await count();
    const [run] = await runsOf(userId);
    await expect(schedules.execute(userId, run.id, execution())).resolves.toBe("succeeded");
    expect(generate.mock.calls[0]![0].template.data).toMatchObject({ followUps: [{ customer: "李静", followUp: "回访李静", overdue: true }], products: [] });
    expect(await count()).toEqual(before);
    expect(await runsOf(userId)).toMatchObject([{ status: "succeeded", report: REPORT }]);
    await expect(schedules.execute(userId, run.id, execution())).resolves.toBe("skipped");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("calls no model when there is nothing to prepare or the quota is short", async () => {
    const quiet = owner();
    await due(quiet);
    await schedules.dispatchDue(DUE);
    await schedules.execute(quiet, (await runsOf(quiet))[0].id, execution());
    expect(await runsOf(quiet)).toMatchObject([{ status: "skipped", reason: "nothing_to_do" }]);

    const poor = owner();
    await withFollowUp(poor);
    await due(poor);
    await schedules.dispatchDue(DUE);
    checkQuota.mockResolvedValueOnce({ ok: false });
    await schedules.execute(poor, (await runsOf(poor))[0].id, execution());
    expect(await runsOf(poor)).toMatchObject([{ status: "skipped", reason: "quota" }]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("records a model failure once and treats a gateway 402 as short quota", async () => {
    const userId = owner();
    await withFollowUp(userId);
    await due(userId);
    await schedules.dispatchDue(DUE);
    generate.mockRejectedValueOnce(new Error("no response"));
    await expect(schedules.execute(userId, (await runsOf(userId))[0].id, execution())).resolves.toBe("failed");
    expect(await runsOf(userId)).toMatchObject([{ status: "failed", reason: "model_failed" }]);
    expect(generate).toHaveBeenCalledOnce();

    const other = owner();
    await withFollowUp(other);
    await due(other);
    await schedules.dispatchDue(DUE);
    generate.mockRejectedValueOnce(Object.assign(new Error("payment required"), { httpStatus: 402 }));
    await schedules.execute(other, (await runsOf(other))[0].id, execution());
    expect(await runsOf(other)).toMatchObject([{ status: "skipped", reason: "quota" }]);
  });

  it("puts a question on the today page until the owner deals with it", async () => {
    const userId = owner();
    await withFollowUp(userId);
    await due(userId);
    await schedules.dispatchDue(DUE);
    const [run] = await runsOf(userId);
    generate.mockResolvedValueOnce({ report: { ...REPORT, question: "李静这周还在考虑吗？" }, modelId: "m" });
    await schedules.execute(userId, run.id, execution());
    const { items } = await service.today.get(userId);
    const [report] = items.filter((item) => item.kind === "report");
    expect(report).toMatchObject({ priority: "high", source: { type: "schedule_run", id: run.id }, scheduleRun: { report: { question: "李静这周还在考虑吗？" } } });
    await schedules.acknowledge(userId, run.id);
    expect((await service.today.get(userId)).items.filter((item) => item.kind === "report")).toEqual([]);
  });

  it("keeps accounts apart", async () => {
    const userId = owner();
    const id = await due(userId);
    await schedules.dispatchDue(DUE);
    const [run] = await runsOf(userId);
    const stranger = owner();
    await expect(schedules.getRun(stranger, run.id)).rejects.toThrow("不存在");
    await expect(schedules.acknowledge(stranger, run.id)).rejects.toThrow("不存在");
    await expect(schedules.remove(stranger, id)).rejects.toThrow("不存在");
    await expect(schedules.execute(stranger, run.id, execution())).resolves.toBe("skipped");
    expect((await schedules.list(stranger)).schedules).toEqual([]);
    await expect(schedules.update(stranger, id, { template: "weekly_review", timing: DAILY, timezone: TZ, enabled: true, version: 1 })).rejects.toThrow("已被更新");
  });

  it("keeps the record of a deleted schedule and does not run what it left queued", async () => {
    const userId = owner();
    await withFollowUp(userId);
    const id = await due(userId);
    await schedules.dispatchDue(DUE);
    await schedules.remove(userId, id);
    await schedules.execute(userId, (await runsOf(userId))[0].id, execution());
    expect(await runsOf(userId)).toMatchObject([{ status: "skipped", reason: "schedule_removed" }]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("limits how many schedules an account keeps", async () => {
    const userId = owner();
    for (let index = 0; index < 10; index += 1) await schedules.create(userId, { template: "weekly_review", timing: DAILY, timezone: TZ, enabled: true });
    await expect(schedules.create(userId, { template: "weekly_review", timing: DAILY, timezone: TZ, enabled: true })).rejects.toThrow("最多");
  });

  it("disappears with the flag off", async () => {
    delete process.env.DIGITAL_EMPLOYEE_SCHEDULES;
    await expect(schedules.list(owner())).rejects.toThrow("未开启");
    await expect(schedules.pendingReports(owner())).resolves.toEqual([]);
    process.env.DIGITAL_EMPLOYEE_SCHEDULES = "1";
  });
});
