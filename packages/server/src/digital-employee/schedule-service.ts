import { randomUUID } from "node:crypto";
import type { JobQueue } from "@lot-agent/core";
import type { Pool } from "pg";
import { ConflictError, InputError, NotFoundError } from "./errors.js";
import { digitalEmployeeSchedulesEnabled } from "./feature-scope.js";
import type { OpportunityService } from "./opportunity-service.js";
import { collectTemplate, type ScheduleReport, type ScheduleTemplate, type TemplateInput } from "./schedule-templates.js";
import { localDate, nextRunAt, type ScheduleTiming } from "./schedule-timing.js";

export const SCHEDULE_JOB = "employee.schedule.run";

const DUE_BATCH = 100;
const SCHEDULE_LIMIT = 10;
const RUN_LIST_LIMIT = 30;
export const DAILY_RUN_LIMIT = 2;
/** Past this the moment has gone: the run is recorded as missed, never replayed. */
const MISSED_AFTER_MS = 10 * 60 * 1000;
/** A run this old lost its worker. It is closed rather than retried, because it may already have called a model. */
const ABANDONED_AFTER = "30 minutes";
const REPORT_DAYS = "7 days";
/** One background report; only has to tell an exhausted account from a healthy one. */
const QUOTA_ESTIMATE = 0.05;

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped" | "missed";
export type RunReason = "overlap" | "daily_limit" | "quota" | "nothing_to_do" | "schedule_removed" | "enqueue_failed" | "model_failed" | "abandoned";

export interface EmployeeSchedule {
  id: string;
  template: ScheduleTemplate;
  timing: ScheduleTiming;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  version: number;
}

export interface ScheduleInput {
  template: ScheduleTemplate;
  timing: ScheduleTiming;
  timezone: string;
  enabled: boolean;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string | null;
  template: ScheduleTemplate;
  scheduledFor: string;
  status: RunStatus;
  reason: RunReason | null;
  report: ScheduleReport | null;
  acknowledgedAt: string | null;
  finishedAt: string | null;
}

/** Everything a run needs from outside. The API process has none of it and only dispatches. */
export interface ScheduleExecution {
  opportunities: Pick<OpportunityService, "list">;
  checkQuota(userId: string, estimatedCost: number): Promise<{ ok: boolean }>;
  generate(input: { userId: string; template: TemplateInput; signal?: AbortSignal }): Promise<{ report: ScheduleReport; modelId: string }>;
}

type Row = Record<string, unknown>;

function toIso(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null;
}

function toSchedule(row: Row): EmployeeSchedule {
  return {
    id: String(row.id), template: row.template as ScheduleTemplate, timing: row.timing as ScheduleTiming, timezone: String(row.timezone),
    enabled: row.enabled === true, nextRunAt: toIso(row.next_run_at), lastRunAt: toIso(row.last_run_at), version: Number(row.version),
  };
}

function toRun(row: Row): ScheduleRun {
  return {
    id: String(row.id), scheduleId: row.schedule_id ? String(row.schedule_id) : null, template: row.template as ScheduleTemplate,
    scheduledFor: toIso(row.scheduled_for)!, status: row.status as RunStatus, reason: (row.reason ?? null) as RunReason | null,
    report: (row.report ?? null) as ScheduleReport | null, acknowledgedAt: toIso(row.acknowledged_at), finishedAt: toIso(row.finished_at),
  };
}

function gatewayQuotaError(error: unknown): boolean {
  return (error as { httpStatus?: number } | null)?.httpStatus === 402;
}

/**
 * Fixed templates on a timetable. A run only reads, then asks the model for text with no tools
 * attached, so it cannot change a business record, send anything or start paid media.
 */
export class ScheduleService {
  constructor(private readonly pool: Pool, private readonly queue?: Pick<JobQueue, "enqueue">) {}

  private assertEnabled() {
    if (!digitalEmployeeSchedulesEnabled()) throw new NotFoundError("定时工作未开启");
  }

  async list(userId: string) {
    this.assertEnabled();
    const [schedules, runs] = await Promise.all([
      this.pool.query(`SELECT * FROM de_employee_schedules WHERE user_id=$1 ORDER BY created_at`, [userId]),
      this.pool.query(`SELECT * FROM de_employee_schedule_runs WHERE user_id=$1 ORDER BY scheduled_for DESC, created_at DESC LIMIT $2`, [userId, RUN_LIST_LIMIT]),
    ]);
    return { schedules: schedules.rows.map(toSchedule), runs: runs.rows.map(toRun) };
  }

  async create(userId: string, input: ScheduleInput, now = new Date()): Promise<EmployeeSchedule> {
    this.assertEnabled();
    const next = this.firstRun(input, now);
    const { rows } = await this.pool.query(
      `INSERT INTO de_employee_schedules (user_id, template, timing, timezone, enabled, next_run_at)
       SELECT $1::varchar, $2::text, $3::jsonb, $4::text, $5::boolean, $6::timestamptz
       WHERE (SELECT count(*) FROM de_employee_schedules WHERE user_id=$1::varchar) < $7::int
       RETURNING *`,
      [userId, input.template, JSON.stringify(input.timing), input.timezone, input.enabled, next, SCHEDULE_LIMIT]
    );
    if (!rows[0]) throw new InputError(`最多安排 ${SCHEDULE_LIMIT} 项定时工作`);
    return toSchedule(rows[0]);
  }

  async update(userId: string, id: string, input: ScheduleInput & { version: number }, now = new Date()): Promise<EmployeeSchedule> {
    this.assertEnabled();
    const next = this.firstRun(input, now);
    const { rows } = await this.pool.query(
      `UPDATE de_employee_schedules
       SET template=$3, timing=$4::jsonb, timezone=$5, enabled=$6, next_run_at=$7, version=version+1, updated_at=now()
       WHERE id=$1 AND user_id=$2 AND version=$8 RETURNING *`,
      [id, userId, input.template, JSON.stringify(input.timing), input.timezone, input.enabled, next, input.version]
    );
    if (!rows[0]) throw new ConflictError("定时工作已被更新，请刷新后重试");
    return toSchedule(rows[0]);
  }

  private firstRun(input: ScheduleInput, now: Date): Date | null {
    if (!input.enabled) return null;
    const next = nextRunAt(input.timing, input.timezone, now);
    if (!next) throw new InputError("执行时间已经过了");
    return next;
  }

  async remove(userId: string, id: string): Promise<void> {
    this.assertEnabled();
    const { rowCount } = await this.pool.query(`DELETE FROM de_employee_schedules WHERE id=$1 AND user_id=$2`, [id, userId]);
    if (!rowCount) throw new NotFoundError("定时工作不存在");
  }

  async getRun(userId: string, id: string): Promise<ScheduleRun> {
    this.assertEnabled();
    const { rows } = await this.pool.query(`SELECT * FROM de_employee_schedule_runs WHERE id=$1 AND user_id=$2`, [id, userId]);
    if (!rows[0]) throw new NotFoundError("工作记录不存在");
    return toRun(rows[0]);
  }

  async acknowledge(userId: string, id: string): Promise<void> {
    this.assertEnabled();
    const { rowCount } = await this.pool.query(
      `UPDATE de_employee_schedule_runs SET acknowledged_at=COALESCE(acknowledged_at, now()) WHERE id=$1 AND user_id=$2`, [id, userId]
    );
    if (!rowCount) throw new NotFoundError("工作记录不存在");
  }

  /** Finished reports nobody has dealt with yet, for the today page. */
  async pendingReports(userId: string): Promise<ScheduleRun[]> {
    if (!digitalEmployeeSchedulesEnabled()) return [];
    const { rows } = await this.pool.query(
      `SELECT * FROM de_employee_schedule_runs
       WHERE user_id=$1 AND status='succeeded' AND acknowledged_at IS NULL AND finished_at > now() - interval '${REPORT_DAYS}'
       ORDER BY finished_at DESC`,
      [userId]
    );
    return rows.map(toRun);
  }

  /** Called every minute. Each schedule moves forward even when its run is skipped or fails. */
  async dispatchDue(now = new Date()): Promise<number> {
    await this.closeAbandoned();
    const { rows } = await this.pool.query(
      `SELECT id FROM de_employee_schedules WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at LIMIT $2`, [now, DUE_BATCH]
    );
    let queued = 0;
    for (const { id } of rows) {
      try {
        if (await this.dispatchOne(String(id), now)) queued += 1;
      } catch (error) {
        console.warn(`[employee-schedule] dispatch failed for ${id}:`, error);
      }
    }
    return queued;
  }

  private async closeAbandoned() {
    await this.pool.query(
      `UPDATE de_employee_schedule_runs SET status='failed', reason='abandoned', finished_at=now()
       WHERE status IN ('queued','running') AND created_at < now() - interval '${ABANDONED_AFTER}'`
    );
  }

  private async dispatchOne(id: string, now: Date): Promise<boolean> {
    const client = await this.pool.connect();
    let run: { id: string; userId: string } | null = null;
    try {
      await client.query("BEGIN");
      const { rows: [row] } = await client.query(
        `SELECT * FROM de_employee_schedules WHERE id=$1 AND enabled AND next_run_at <= $2 FOR UPDATE SKIP LOCKED`, [id, now]
      );
      if (!row) { await client.query("ROLLBACK"); return false; }
      const schedule = toSchedule(row);
      const occurrence = new Date(row.next_run_at);
      const next = nextRunAt(schedule.timing, schedule.timezone, now);
      await client.query(
        `UPDATE de_employee_schedules SET next_run_at=$2, enabled=$3, last_run_at=$4, updated_at=now() WHERE id=$1`,
        [id, next, next !== null, occurrence]
      );
      const day = localDate(occurrence, schedule.timezone);
      const record = (status: RunStatus, reason: RunReason | null) => client.query(
        `INSERT INTO de_employee_schedule_runs
           (id, schedule_id, user_id, template, scheduled_for, local_date, status, reason, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7='queued' THEN NULL ELSE now() END)
         ON CONFLICT (schedule_id, scheduled_for) DO NOTHING RETURNING id`,
        [randomUUID(), id, row.user_id, schedule.template, occurrence, day, status, reason]
      );
      if (now.getTime() - occurrence.getTime() > MISSED_AFTER_MS) {
        await record("missed", null);
      } else {
        // Two schedules of one template can fall due in the same minute.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`employee-schedule:${row.user_id}:${schedule.template}`]);
        const { rows: [state] } = await client.query(
          `SELECT
             EXISTS (SELECT 1 FROM de_employee_schedule_runs WHERE schedule_id=$1 AND status IN ('queued','running')) AS busy,
             (SELECT count(*) FROM de_employee_schedule_runs
              WHERE user_id=$2 AND template=$3 AND local_date=$4 AND status IN ('queued','running','succeeded','failed','cancelled'))::int AS used`,
          [id, row.user_id, schedule.template, day]
        );
        if (state.busy) await record("skipped", "overlap");
        else if (state.used >= DAILY_RUN_LIMIT) await record("skipped", "daily_limit");
        else {
          const inserted = await record("queued", null);
          if (inserted.rows[0]) run = { id: String(inserted.rows[0].id), userId: String(row.user_id) };
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!run) return false;
    return this.enqueue(run);
  }

  private async enqueue(run: { id: string; userId: string }): Promise<boolean> {
    try {
      if (!this.queue) throw new Error("schedule queue unavailable");
      const taskId = await this.queue.enqueue(SCHEDULE_JOB, { runId: run.id }, run.userId, { maxAttempts: 1, idempotencyKey: `employee-schedule:${run.id}` });
      await this.pool.query(`UPDATE de_employee_schedule_runs SET task_id=$2 WHERE id=$1`, [run.id, taskId]);
      return true;
    } catch (error) {
      console.warn(`[employee-schedule] enqueue failed for run ${run.id}:`, error);
      await this.finish(run.id, "failed", "enqueue_failed");
      return false;
    }
  }

  private async finish(id: string, status: RunStatus, reason: RunReason | null, result?: { report: ScheduleReport; modelId: string }) {
    await this.pool.query(
      `UPDATE de_employee_schedule_runs SET status=$2, reason=$3, report=$4::jsonb, model_id=$5, finished_at=now()
       WHERE id=$1 AND status IN ('queued','running')`,
      [id, status, reason, result ? JSON.stringify(result.report) : null, result?.modelId ?? null]
    );
  }

  /** One attempt only: nothing here retries, and the queue is told not to either. */
  async execute(userId: string, runId: string, ports: ScheduleExecution, signal?: AbortSignal): Promise<RunStatus> {
    const { rows: [run] } = await this.pool.query(
      `UPDATE de_employee_schedule_runs SET status='running', started_at=now()
       WHERE id=$1 AND user_id=$2 AND status='queued' RETURNING template, schedule_id`,
      [runId, userId]
    );
    if (!run) return "skipped";
    const skip = async (reason: RunReason): Promise<RunStatus> => { await this.finish(runId, "skipped", reason); return "skipped"; };
    if (!run.schedule_id) return skip("schedule_removed");
    try {
      const template = await collectTemplate(run.template as ScheduleTemplate, { pool: this.pool, opportunities: ports.opportunities }, userId);
      if (!template.worthRunning) return skip("nothing_to_do");
      if (!(await ports.checkQuota(userId, QUOTA_ESTIMATE)).ok) return skip("quota");
      signal?.throwIfAborted();
      await this.finish(runId, "succeeded", null, await ports.generate({ userId, template, signal }));
      return "succeeded";
    } catch (error) {
      if (signal?.aborted) { await this.finish(runId, "cancelled", null); return "cancelled"; }
      if (gatewayQuotaError(error)) return skip("quota");
      console.warn(`[employee-schedule] run ${runId} failed:`, error);
      await this.finish(runId, "failed", "model_failed");
      return "failed";
    }
  }
}
