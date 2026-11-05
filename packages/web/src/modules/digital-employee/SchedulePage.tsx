import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/index.js";
import { employeeApi } from "./api.js";
import type { DigitalEmployeeOverview, EmployeeSettings, OpportunitySettings } from "./types.js";

const MAX_NAME = 20;

/** The employee's name and everything it does on its own. Both automatic jobs call a model. */
export function SchedulePage({ onNameChange }: { onNameChange: (name: string) => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<EmployeeSettings | null>(null);
  const [name, setName] = useState("");
  const [discovery, setDiscovery] = useState<OpportunitySettings | null>(null);
  const [cohort, setCohort] = useState<DigitalEmployeeOverview["schedule"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      employeeApi.getEmployeeSettings(), employeeApi.getOpportunitySettings(), employeeApi.getDigitalEmployeeOverview(),
    ]).then(([nextSettings, nextDiscovery, overview]) => {
      if (!active) return;
      setSettings(nextSettings);
      setName(nextSettings.employeeName);
      setDiscovery(nextDiscovery);
      setCohort(overview.schedule);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "读取失败"); });
    return () => { active = false; };
  }, []);

  const guarded = async (operation: () => Promise<void>) => {
    setSaving(true); setError(null); setSaved(false);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setSaving(false); }
  };

  const saveName = () => guarded(async () => {
    const next = await employeeApi.saveEmployeeSettings({ ...settings!, employeeName: name.trim() });
    setSettings(next);
    setName(next.employeeName);
    setSaved(true);
    onNameChange(next.employeeName);
  });

  const trimmed = name.trim();
  const nameValid = [...trimmed].length >= 1 && [...trimmed].length <= MAX_NAME;

  return <div className="de-page de-schedule-page">
    <header className="de-employee-page-head"><h1>{t("工作安排")}</h1></header>
    {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span><button onClick={() => setError(null)}>{t("关闭")}</button></div>}
    {!settings ? !error && <div className="de-state">{t("加载中…")}</div> : <>
      <section className="de-schedule-section">
        <h2>{t("员工名字")}</h2>
        <form onSubmit={(event) => { event.preventDefault(); if (nameValid && trimmed !== settings.employeeName) void saveName(); }}>
          <input aria-label={t("员工名字")} value={name} maxLength={MAX_NAME * 2} onChange={(event) => { setName(event.target.value); setSaved(false); }} />
          <button className="de-primary-button" disabled={saving || !nameValid || trimmed === settings.employeeName}>{t("保存")}</button>
          {saved && <span role="status">{t("已保存")}</span>}
        </form>
        <p>{t("1–20 个字。新回合和界面都会用这个名字。")}</p>
      </section>
      <section className="de-schedule-section">
        <h2>{t("自动准备")}</h2>
        <p>{t("开启后每天自动运行，会产生模型费用。")}</p>
        {discovery && <div className="de-schedule-row">
          <label className="de-switch">
            <input
              type="checkbox"
              checked={discovery.enabled}
              disabled={saving}
              onChange={(event) => void guarded(async () => {
                setDiscovery(await employeeApi.saveOpportunitySettings({ ...discovery, enabled: event.target.checked }));
              })}
            />
            <i /><span>{t("每日自动发现")}</span>
          </label>
          <label className="de-schedule-time">
            <span>{t("执行时间")}</span>
            <input
              type="time"
              value={discovery.dailyRunTime}
              disabled={!discovery.enabled || saving}
              onChange={(event) => void guarded(async () => {
                setDiscovery(await employeeApi.saveOpportunitySettings({ ...discovery, dailyRunTime: event.target.value }));
              })}
            />
          </label>
        </div>}
        {cohort && <div className="de-schedule-row">
          <label className="de-switch">
            <input
              type="checkbox"
              checked={cohort.enabled}
              disabled={saving}
              onChange={(event) => void guarded(async () => {
                setCohort(await employeeApi.saveDigitalEmployeeCohortSchedule({ enabled: event.target.checked, version: cohort.version }));
              })}
            />
            <i /><span>{t("群像总结")}</span>
          </label>
          <small>{cohort.enabled ? t("每晚 23:00 自动更新") : t("自动更新已关闭")}</small>
        </div>}
      </section>
    </>}
  </div>;
}
