import type { Pool } from "pg";

export interface BriefCounts {
  /** Customers looked at and opportunities found by the morning scan. */
  scanned: number;
  created: number;
  confirm: number;
  followUps: number;
  results: number;
  /** Everything waiting on the owner when the brief was written. */
  pending: number;
}

export interface EmployeeBrief {
  id: string;
  date: string;
  counts: BriefCounts;
  readAt: string | null;
}

export interface BriefDelivery {
  id: string;
  userId: string;
  date: string;
  counts: BriefCounts;
}

const RECENT = "interval '24 hours'";
const REFERENCE_LIMIT = 50;

/** The calendar day in the account's own time zone, so a brief belongs to the morning it was read. */
export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The owner's language decides the wording; only the Feishu message is written on the server. */
export function briefMessage(counts: BriefCounts, name: string, english: boolean): string {
  return english
    ? `${name}: morning brief. To confirm: ${counts.confirm}. To follow up: ${counts.followUps}. Results to report: ${counts.results}.`
    : `${name}的今日简报：待确认 ${counts.confirm} 件，要跟进 ${counts.followUps} 位客户，等结果 ${counts.results} 个。`;
}

export class BriefService {
  constructor(private readonly pool: Pool) {}

  /** The first scan of the day wins, so a retried job cannot rewrite what was already sent. */
  async write(userId: string, counts: BriefCounts, itemIds: string[], now = new Date()): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT timezone FROM de_follow_up_automation_settings WHERE user_id=$1`, [userId]
    );
    await this.pool.query(
      `INSERT INTO de_employee_briefs (user_id, brief_date, counts, item_refs)
       VALUES ($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT (user_id, brief_date) DO NOTHING`,
      [userId, localDate(now, rows[0]?.timezone ?? "Asia/Shanghai"), JSON.stringify(counts), JSON.stringify(itemIds.slice(0, REFERENCE_LIMIT))]
    );
  }

  async latest(userId: string): Promise<EmployeeBrief | null> {
    const { rows } = await this.pool.query(
      `SELECT id, brief_date, counts, read_at FROM de_employee_briefs
       WHERE user_id=$1 AND created_at > now() - ${RECENT} ORDER BY brief_date DESC LIMIT 1`,
      [userId]
    );
    return rows[0] ? {
      id: String(rows[0].id), date: dateText(rows[0].brief_date), counts: rows[0].counts as BriefCounts,
      readAt: rows[0].read_at ? new Date(rows[0].read_at).toISOString() : null,
    } : null;
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.pool.query(`UPDATE de_employee_briefs SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL`, [id, userId]);
  }

  /**
   * Claims before sending, so a restart or a second instance cannot send twice. An attempt
   * that fails is not repeated: the outcome of a failed send can be unknown, and the
   * brief is still on the today page.
   */
  async claimFeishuDeliveries(limit: number): Promise<BriefDelivery[]> {
    const { rows } = await this.pool.query(
      `UPDATE de_employee_briefs brief SET feishu_attempted_at=now()
       FROM de_employee_settings settings
       WHERE settings.user_id=brief.user_id AND settings.feishu_reminder=true
         AND brief.feishu_attempted_at IS NULL AND brief.created_at > now() - ${RECENT}
         AND (brief.counts->>'pending')::int > 0
         AND brief.id IN (
           SELECT id FROM de_employee_briefs WHERE feishu_attempted_at IS NULL ORDER BY created_at LIMIT $1
         )
       RETURNING brief.id, brief.user_id, brief.brief_date, brief.counts`,
      [limit]
    );
    return rows.map((row) => ({
      id: String(row.id), userId: String(row.user_id), date: dateText(row.brief_date), counts: row.counts as BriefCounts,
    }));
  }

  async markDelivered(id: string): Promise<void> {
    await this.pool.query(`UPDATE de_employee_briefs SET delivered_at=now() WHERE id=$1`, [id]);
  }
}

function dateText(value: unknown): string {
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  return String(value).slice(0, 10);
}
