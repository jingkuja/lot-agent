import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import type { EmployeeSchedule, ScheduleTemplate, ScheduleTiming } from "../types.js";
import { TEMPLATE_HINTS, TEMPLATE_LABELS, WEEKDAYS, timingText } from "./labels.js";

type Kind = ScheduleTiming["kind"];

const TEMPLATES = Object.keys(TEMPLATE_LABELS) as ScheduleTemplate[];

function buildTiming(kind: Kind, time: string, weekday: number, at: string): ScheduleTiming | null {
  if (kind === "once") return at ? { kind, at: new Date(at).toISOString() } : null;
  const [hour, minute] = time.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return kind === "daily" ? { kind, hour: hour!, minute: minute! } : { kind, weekday, hour: hour!, minute: minute! };
}

/** Fixed work on a timetable. It only reads and writes a report for the owner. */
export function ScheduledWorkSection() {
  const { t, locale } = useI18n();
  const [schedules, setSchedules] = useState<EmployeeSchedule[] | null>(null);
  const [template, setTemplate] = useState<ScheduleTemplate>("follow_up_prep");
  const [kind, setKind] = useState<Kind>("daily");
  const [time, setTime] = useState("08:30");
  const [weekday, setWeekday] = useState(1);
  const [at, setAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => employeeApi.listSchedules().then((result) => setSchedules(result.schedules));
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "读取失败")); }, []);

  const guarded = async (operation: () => Promise<unknown>) => {
    setSaving(true); setError(null);
    try { await operation(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setSaving(false); }
  };

  const timing = buildTiming(kind, time, weekday, at);
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!timing) return;
    void guarded(() => employeeApi.createSchedule({
      template, timing, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: true,
    }));
  };

  return <section className="de-schedule-section de-scheduled-work" aria-label={t("定时工作")}>
    <h2>{t("定时工作")}</h2>
    <p>{t("到时间自动准备一份报告放到今天页，会产生模型费用。只读取资料，不改记录，不发消息。额度不足或错过时间不会补跑。")}</p>
    {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span><button onClick={() => setError(null)}>{t("关闭")}</button></div>}
    {schedules?.map((schedule) => <div key={schedule.id} className="de-schedule-row">
      <label className="de-switch">
        <input
          type="checkbox"
          checked={schedule.enabled}
          disabled={saving}
          onChange={(event) => void guarded(() => employeeApi.updateSchedule(schedule.id, {
            template: schedule.template, timing: schedule.timing, timezone: schedule.timezone, enabled: event.target.checked, version: schedule.version,
          }))}
        />
        <i /><span>{t(TEMPLATE_LABELS[schedule.template])}</span>
      </label>
      <small>{timingText(schedule.timing, t, locale)}</small>
      <button type="button" className="de-quiet-button" disabled={saving} onClick={() => void guarded(() => employeeApi.deleteSchedule(schedule.id))}>
        {t("删除")}
      </button>
    </div>)}
    <form className="de-schedule-add" onSubmit={add}>
      <select aria-label={t("工作内容")} value={template} onChange={(event) => setTemplate(event.target.value as ScheduleTemplate)}>
        {TEMPLATES.map((value) => <option key={value} value={value}>{t(TEMPLATE_LABELS[value])}</option>)}
      </select>
      <select aria-label={t("重复")} value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
        <option value="once">{t("一次")}</option>
        <option value="daily">{t("每天")}</option>
        <option value="weekly">{t("每周")}</option>
      </select>
      {kind === "weekly" && <select aria-label={t("星期")} value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
        {WEEKDAYS.map((label, index) => <option key={label} value={index}>{t(label)}</option>)}
      </select>}
      {kind === "once"
        ? <input aria-label={t("执行时间")} type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
        : <input aria-label={t("执行时间")} type="time" value={time} onChange={(event) => setTime(event.target.value)} />}
      <button className="de-primary-button" disabled={saving || !timing}>{t("添加")}</button>
    </form>
    <small>{t(TEMPLATE_HINTS[template])}</small>
  </section>;
}
