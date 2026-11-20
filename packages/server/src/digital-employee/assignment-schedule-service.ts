import type { Pool, PoolClient } from "pg";
import { nextAssignmentRunAt, type AssignmentScheduleTiming } from "./assignment-schedule-timing.js";
import type { AssignmentService, CreateAssignmentInput } from "./assignment-service.js";
import { ConflictError, InputError, NotFoundError } from "./errors.js";
import { digitalEmployeeAssignmentsEnabled } from "./feature-scope.js";

const DUE_BATCH = 50;
const SCHEDULE_LIMIT = 20;

export interface AssignmentScheduleInput {
  assignment: CreateAssignmentInput;
  timing: AssignmentScheduleTiming;
  timezone: string;
}

export interface AssignmentSchedule extends AssignmentScheduleInput {
  id: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastAssignmentId: string | null;
  lastError: string | null;
  version: number;
  createdAt: string;
}

type Row = Record<string, any>;
type AssignmentCreator = Pick<AssignmentService, "create" | "validate">;

const iso = (value: unknown): string => new Date(value as string).toISOString();
const optionalIso = (value: unknown): string | null => value ? iso(value) : null;

function view(row: Row): AssignmentSchedule {
  return {
    id: String(row.id), assignment: row.assignment_input as CreateAssignmentInput, timing: row.timing as AssignmentScheduleTiming,
    timezone: String(row.timezone), enabled: row.enabled === true, nextRunAt: optionalIso(row.next_run_at), lastRunAt: optionalIso(row.last_run_at),
    lastAssignmentId: row.last_assignment_id ? String(row.last_assignment_id) : null, lastError: row.last_error ?? null,
    version: Number(row.version), createdAt: iso(row.created_at),
  };
}

/** Due occurrences become ordinary assignments, so planning, tools, retries, notifications and detail pages are shared. */
export class AssignmentScheduleService {
  constructor(private readonly pool: Pool, private readonly assignments: AssignmentCreator) {}

  private assertEnabled() {
    if (!digitalEmployeeAssignmentsEnabled()) throw new NotFoundError("任务分派未开启");
  }

  async list(userId: string): Promise<AssignmentSchedule[]> {
    this.assertEnabled();
    const { rows } = await this.pool.query(
      `SELECT * FROM de_assignment_schedules WHERE user_id=$1 ORDER BY created_at DESC, id DESC`, [userId]
    );
    return rows.map(view);
  }

  async create(userId: string, input: AssignmentScheduleInput, now = new Date()): Promise<AssignmentSchedule> {
    this.assertEnabled();
    await this.assignments.validate(userId, input.assignment);
    const next = nextAssignmentRunAt(input.timing, now);
    if (!next) throw new InputError("执行时间已经过了");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize only this owner's short count-and-insert section, so parallel requests cannot cross the limit.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`employee-assignment-schedule:${userId}`]);
      const { rows } = await client.query(
        `INSERT INTO de_assignment_schedules (user_id, assignment_input, timing, timezone, enabled, next_run_at)
         SELECT $1::varchar, $2::jsonb, $3::jsonb, $4::text, true, $5::timestamptz
         WHERE (SELECT count(*) FROM de_assignment_schedules WHERE user_id=$1::varchar) < $6::int
         RETURNING *`,
        [userId, JSON.stringify(input.assignment), JSON.stringify(input.timing), input.timezone, next, SCHEDULE_LIMIT]
      );
      if (!rows[0]) throw new InputError(`最多创建 ${SCHEDULE_LIMIT} 个定时任务`);
      await client.query("COMMIT");
      return view(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setEnabled(userId: string, id: string, enabled: boolean, now = new Date()): Promise<AssignmentSchedule> {
    this.assertEnabled();
    const { rows: [current] } = await this.pool.query(
      `SELECT * FROM de_assignment_schedules WHERE id=$1 AND user_id=$2`, [id, userId]
    );
    if (!current) throw new NotFoundError("定时任务不存在");
    if (current.enabled === enabled) throw new ConflictError(enabled ? "定时任务已经开启" : "定时任务已经暂停");
    const next = enabled ? nextAssignmentRunAt(current.timing as AssignmentScheduleTiming, now) : null;
    if (enabled && !next) throw new InputError("执行时间已经过了");
    const { rows } = await this.pool.query(
      `UPDATE de_assignment_schedules
       SET enabled=$3, next_run_at=$4, version=version+1, updated_at=now()
       WHERE id=$1 AND user_id=$2 AND enabled=$5 RETURNING *`,
      [id, userId, enabled, next, !enabled]
    );
    if (!rows[0]) throw new ConflictError("定时任务状态已变化，请刷新后重试");
    return view(rows[0]);
  }

  async remove(userId: string, id: string): Promise<void> {
    this.assertEnabled();
    const { rowCount } = await this.pool.query(`DELETE FROM de_assignment_schedules WHERE id=$1 AND user_id=$2`, [id, userId]);
    if (!rowCount) throw new NotFoundError("定时任务不存在");
  }

  async dispatchDue(now = new Date()): Promise<number> {
    if (!digitalEmployeeAssignmentsEnabled()) return 0;
    const { rows } = await this.pool.query(
      `SELECT id FROM de_assignment_schedules WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at LIMIT $2`, [now, DUE_BATCH]
    );
    let created = 0;
    for (const { id } of rows) {
      try {
        if (await this.dispatchOne(String(id), now)) created += 1;
      } catch (error) {
        console.warn(`[employee-assignment-schedule] dispatch failed for ${id}:`, error);
      }
    }
    return created;
  }

  private async dispatchOne(id: string, now: Date): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Exclude rival dispatchers without blocking the assignment insert's FOR KEY SHARE foreign-key check.
      const { rows: [row] } = await client.query(
        `SELECT * FROM de_assignment_schedules WHERE id=$1 AND enabled AND next_run_at <= $2 FOR NO KEY UPDATE SKIP LOCKED`, [id, now]
      );
      if (!row) {
        await client.query("ROLLBACK");
        return false;
      }
      const occurrence = iso(row.next_run_at);
      try {
        const assignment = await this.assignments.create(row.user_id, row.assignment_input as CreateAssignmentInput, {
          scheduleId: id, scheduledFor: occurrence,
        });
        await this.complete(client, row, now, occurrence, assignment.id, null);
      } catch (error) {
        if (!(error instanceof InputError) && !(error instanceof NotFoundError)) throw error;
        await this.complete(client, row, now, occurrence, null, error.message.slice(0, 500));
        await client.query("COMMIT");
        return false;
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async complete(
    client: PoolClient, row: Row, now: Date, occurrence: string, assignmentId: string | null, error: string | null
  ): Promise<void> {
    const next = nextAssignmentRunAt(row.timing as AssignmentScheduleTiming, now);
    await client.query(
      `UPDATE de_assignment_schedules
       SET enabled=$2, next_run_at=$3, last_run_at=$4, last_assignment_id=COALESCE($5, last_assignment_id),
           last_error=$6, version=version+1, updated_at=now()
       WHERE id=$1`,
      [row.id, next !== null, next, occurrence, assignmentId, error]
    );
  }
}
