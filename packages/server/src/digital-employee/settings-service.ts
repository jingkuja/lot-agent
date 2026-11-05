import type { Pool } from "pg";
import { DEFAULT_EMPLOYEE_NAME } from "./employee-name.js";
import { ConflictError } from "./errors.js";

export interface EmployeeSettings {
  employeeName: string;
  feishuReminder: boolean;
  desktopReminder: boolean;
  /** 0 until the owner saves for the first time. */
  version: number;
}

export type EmployeeSettingsInput = EmployeeSettings;

const DEFAULTS: EmployeeSettings = {
  employeeName: DEFAULT_EMPLOYEE_NAME, feishuReminder: false, desktopReminder: false, version: 0,
};

/** The name reaches the prompt and the interface from here; both read it on every turn or page load. */
export class EmployeeSettingsService {
  constructor(private readonly pool: Pool) {}

  async get(userId: string): Promise<EmployeeSettings> {
    const { rows } = await this.pool.query(
      `SELECT employee_name, feishu_reminder, desktop_reminder, version
       FROM de_employee_settings WHERE user_id = $1`,
      [userId]
    );
    return rows[0] ? toSettings(rows[0]) : { ...DEFAULTS };
  }

  async save(userId: string, input: EmployeeSettingsInput): Promise<EmployeeSettings> {
    const values = [userId, input.employeeName, input.feishuReminder, input.desktopReminder];
    const { rows } = input.version === 0
      ? await this.pool.query(
        `INSERT INTO de_employee_settings (user_id, employee_name, feishu_reminder, desktop_reminder)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING
         RETURNING employee_name, feishu_reminder, desktop_reminder, version`,
        values
      )
      : await this.pool.query(
        `UPDATE de_employee_settings
         SET employee_name = $2, feishu_reminder = $3, desktop_reminder = $4, version = version + 1, updated_at = now()
         WHERE user_id = $1 AND version = $5
         RETURNING employee_name, feishu_reminder, desktop_reminder, version`,
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
    version: Number(row.version),
  };
}
