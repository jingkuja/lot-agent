import type { Pool } from "pg";
import { DEFAULT_EMPLOYEE_NAME } from "./employee-name.js";
import { ConflictError } from "./errors.js";
import type { WorkChannel, WorkPreferences, WorkTone } from "./work-preferences.js";

export interface EmployeeSettings extends WorkPreferences {
  employeeName: string;
  feishuReminder: boolean;
  desktopReminder: boolean;
  /** 0 until the owner saves for the first time. */
  version: number;
}

export type EmployeeSettingsInput = EmployeeSettings;

const DEFAULTS: EmployeeSettings = {
  employeeName: DEFAULT_EMPLOYEE_NAME, feishuReminder: false, desktopReminder: false, workTone: null, preferredChannels: [], version: 0,
};

const COLUMNS = "employee_name, feishu_reminder, desktop_reminder, work_tone, preferred_channels, version";

/** The name reaches the prompt and the interface from here; both read it on every turn or page load. */
export class EmployeeSettingsService {
  constructor(private readonly pool: Pool) {}

  async get(userId: string): Promise<EmployeeSettings> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM de_employee_settings WHERE user_id = $1`,
      [userId]
    );
    return rows[0] ? toSettings(rows[0]) : { ...DEFAULTS };
  }

  async save(userId: string, input: EmployeeSettingsInput): Promise<EmployeeSettings> {
    const values = [userId, input.employeeName, input.feishuReminder, input.desktopReminder, input.workTone, input.preferredChannels];
    const { rows } = input.version === 0
      ? await this.pool.query(
        `INSERT INTO de_employee_settings (user_id, employee_name, feishu_reminder, desktop_reminder, work_tone, preferred_channels)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        values
      )
      : await this.pool.query(
        `UPDATE de_employee_settings
         SET employee_name = $2, feishu_reminder = $3, desktop_reminder = $4, work_tone = $5, preferred_channels = $6,
             version = version + 1, updated_at = now()
         WHERE user_id = $1 AND version = $7
         RETURNING ${COLUMNS}`,
        [...values, input.version]
      );
    if (!rows[0]) throw new ConflictError("设置已被更新，请刷新后重试");
    return toSettings(rows[0]);
  }
}

function toSettings(row: Record<string, unknown>): EmployeeSettings {
  return {
    employeeName: String(row.employee_name),
    feishuReminder: row.feishu_reminder === true,
    desktopReminder: row.desktop_reminder === true,
    workTone: (row.work_tone ?? null) as WorkTone | null,
    preferredChannels: (row.preferred_channels ?? []) as WorkChannel[],
    version: Number(row.version),
  };
}
