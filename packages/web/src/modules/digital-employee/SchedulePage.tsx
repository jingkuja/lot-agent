import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/index.js";
import { employeeApi } from "./api.js";
import { ScheduledWorkSection } from "./schedule/ScheduledWorkSection.js";
import type { DigitalEmployeeOverview, EmployeeSettings, OpportunitySettings, WorkChannel, WorkTone } from "./types.js";
import { useEmployeeLabels } from "./employee-labels.js";

const MAX_NAME = 20;
const TONES: Array<{ value: WorkTone | ""; label: string }> = [
  { value: "", label: "不指定" },
  { value: "warm", label: "亲切" },
  { value: "professional", label: "专业" },
  { value: "concise", label: "简短直接" },
  { value: "lively", label: "活泼" },
];
const CHANNELS: Array<{ value: WorkChannel; label: string }> = [
  { value: "wechat", label: "微信" },
  { value: "wecom", label: "企微" },
  { value: "phone", label: "电话" },
  { value: "email", label: "邮件" },
  { value: "visit", label: "线下拜访" },
  { value: "moments", label: "朋友圈" },
  { value: "wechat_official", label: "公众号" },
  { value: "channels", label: "视频号" },
  { value: "douyin_kuaishou", label: "抖音和快手" },
  { value: "xiaohongshu", label: "小红书" },
];

/** The employee's name and everything it does on its own. Only the rule scan is free of model costs. */
export function SchedulePage({ employeeName, dailyScan, schedules, onNameChange }: {
  employeeName: string;
  dailyScan: boolean;
  schedules: boolean;
  onNameChange: (name: string) => void;
}) {
  const { t } = useI18n();
  const labels = useEmployeeLabels(employeeName);
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

  const saveReminders = (patch: Partial<EmployeeSettings>) => guarded(async () => {
    setSettings(await employeeApi.saveEmployeeSettings({ ...settings!, ...patch }));
  });

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
    <header className="de-employee-page-head"><h1>{labels.schedule}</h1></header>
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
        <h2>{t("工作偏好")}</h2>
        <p>{t("写话术和文案时默认这样做。客户的情况不用写在这里，告诉员工就会记到客户资料里。")}</p>
        <div className="de-schedule-row">
          <label className="de-schedule-time">
            <span>{t("语气")}</span>
            <select
              aria-label={t("语气")}
              value={settings.workTone ?? ""}
              disabled={saving}
              onChange={(event) => void saveReminders({ workTone: (event.target.value || null) as WorkTone | null })}
            >
              {TONES.map((tone) => <option key={tone.value} value={tone.value}>{t(tone.label)}</option>)}
            </select>
          </label>
        </div>
        <fieldset className="de-schedule-channels" disabled={saving}>
          <legend>{t("常用渠道")}</legend>
          <div className="de-check-row">
            {CHANNELS.map((channel) => <label key={channel.value}>
              <input
                type="checkbox"
                checked={settings.preferredChannels.includes(channel.value)}
                onChange={(event) => void saveReminders({
                  preferredChannels: event.target.checked
                    ? [...settings.preferredChannels, channel.value]
                    : settings.preferredChannels.filter((item) => item !== channel.value),
                })}
              />
              {t(channel.label)}
            </label>)}
          </div>
        </fieldset>
      </section>
      <section className="de-schedule-section">
        <h2>{t("自动准备")}</h2>
        <p>{dailyScan ? t("每天按规则看一遍客户，不产生模型费用。") : t("开启后每天自动运行，会产生模型费用。")}</p>
        {discovery && <div className="de-schedule-row">
          <label className="de-switch">
            <input
              type="checkbox"
              checked={discovery.enabled}
              disabled={saving}
              onChange={(event) => void guarded(async () => {
                setDiscovery(await employeeApi.saveOpportunitySettings({
                  ...discovery, enabled: event.target.checked, discoveryMode: dailyScan ? discovery.discoveryMode : "hybrid",
                }));
              })}
            />
            <i /><span>{dailyScan ? t("每天看一遍客户") : t("每日自动发现")}</span>
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
        {discovery && dailyScan && <div className="de-schedule-row">
          <label className="de-switch">
            <input
              type="checkbox"
              checked={discovery.discoveryMode === "hybrid"}
              disabled={!discovery.enabled || saving}
              onChange={(event) => void guarded(async () => {
                setDiscovery(await employeeApi.saveOpportunitySettings({ ...discovery, discoveryMode: event.target.checked ? "hybrid" : "rules" }));
              })}
            />
            <i /><span>{t("用模型提前写好建议")}</span>
          </label>
          <small>{t("每天产生模型费用")}</small>
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
          <small>{cohort.enabled ? t("每晚 23:00 自动更新，产生模型费用") : t("自动更新已关闭")}</small>
        </div>}
      </section>
      {schedules && <ScheduledWorkSection />}
      {dailyScan && <section className="de-schedule-section">
        <h2>{t("提醒")}</h2>
        <p>{t("简报准备好时告诉你。站内一直有提醒。")}</p>
        <div className="de-schedule-row">
          <label className="de-switch">
            <input
              type="checkbox"
              checked={settings.desktopReminder}
              disabled={saving}
              onChange={(event) => void saveReminders({ desktopReminder: event.target.checked })}
            />
            <i /><span>{t("桌面提醒")}</span>
          </label>
          <small>{t("只在桌面应用运行时生效")}</small>
        </div>
        <div className="de-schedule-row">
          <label className="de-switch">
            <input
              type="checkbox"
              checked={settings.feishuReminder}
              disabled={saving}
              onChange={(event) => void saveReminders({ feishuReminder: event.target.checked })}
            />
            <i /><span>{t("飞书提醒")}</span>
          </label>
          <small>{t("只发给你本人，需要先接入飞书")}</small>
        </div>
      </section>}
    </>}
  </div>;
}
