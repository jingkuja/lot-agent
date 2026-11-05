import { useI18n } from "../../../i18n/index.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../../api/client.js";
import { employeeApi } from "../api.js";
import {
  EMPTY_FILTERS, OpportunityCard, OpportunityFilters, formatTime,
  type FilterValues,
} from "./OpportunityCard.js";
import {
  AcceptDialog, CreateActionDialog, DismissDialog, RescheduleDialog, ResultDialog, SnoozeDialog,
} from "./OpportunityDialogs.js";
import type { OpportunityItem, OpportunityListResponse, OpportunitySettings, OpportunityView } from "../types.js";

interface Props {
  onOpenProfile: (id: string) => void;
  onCreateProfile: () => void;
  onOpenChat?: () => void;
}

const VIEWS: Array<{ id: OpportunityView; label: string }> = [
  { id: "today", label: "今日经营" },
  { id: "pending", label: "待判断" },
  { id: "snoozed", label: "稍后处理" },
  { id: "in_progress", label: "跟进中" },
  { id: "awaiting_result", label: "待回填" },
  { id: "completed", label: "已完成" },
];

export function OpportunityAdvisorPage({ onOpenProfile, onCreateProfile, onOpenChat }: Props) {
  const { t } = useI18n();
  const [view, setView] = useState<OpportunityView>("today");
  const [data, setData] = useState<OpportunityListResponse | null>(null);
  const [filters, setFilters] = useState<FilterValues>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverProgress, setDiscoverProgress] = useState(0);
  const [discoverNotice, setDiscoverNotice] = useState<string | null>(null);
  const [active, setActive] = useState<OpportunityItem | null>(null);
  const [dialog, setDialog] = useState<"accept" | "snooze" | "dismiss" | "reschedule" | "result" | "create" | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await employeeApi.listOpportunities({ view, ...filters })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "商机加载失败"); }
    finally { setLoading(false); }
  }, [view, filters]);
  useEffect(() => { void load(); }, [load]);

  const discover = async () => {
    if (discovering) return;
    setDiscovering(true); setDiscoverProgress(2); setError(null); setDiscoverNotice(null);
    try {
      const { taskId } = await employeeApi.discoverOpportunities();
      let createdCount: number | null = null;
      for (;;) {
        const task = await api.getTask(taskId);
        setDiscoverProgress(task.progress);
        if (task.status === "succeeded") {
          const raw = task.output?.created;
          const parsed = typeof raw === "number" ? raw : Number(raw);
          createdCount = Number.isFinite(parsed) ? parsed : null;
          break;
        }
        if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error || "商机发现未完成");
        await new Promise((resolve) => window.setTimeout(resolve, 800));
      }
      setView("pending");
      await load();
      if (createdCount != null && createdCount > 0) {
        setDiscoverNotice(`发现了 ${createdCount} 条新商机，已刷新「待判断」列表`);
      } else {
        setDiscoverNotice("暂无新商机（已有建议可能因去重未重复创建）");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "商机发现失败"); }
    finally { setDiscovering(false); setDiscoverProgress(0); }
  };

  const saveSettings = async (settings: OpportunitySettings) => {
    setSavingSettings(true); setError(null);
    try {
      const saved = await employeeApi.saveOpportunitySettings(settings);
      setData((current) => current ? { ...current, settings: saved } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "自动发现设置保存失败"); }
    finally { setSavingSettings(false); }
  };

  const openDialog = (item: OpportunityItem, next: typeof dialog) => { setActive(item); setDialog(next); };
  const closeDialog = () => { setDialog(null); setActive(null); };
  const mutate = async (operation: () => Promise<unknown>) => {
    setError(null);
    try { await operation(); closeDialog(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
  };

  const counts = useMemo(() => data?.summary.viewCounts, [data]);

  return (
    <div className="de-page de-opportunity-page">
      <header className="de-opportunity-header">
        <div>
          <p className="de-eyebrow">{t("数字员工 / 商机雷达")}</p>
          <h1>{t("商机雷达")}</h1>
          <p>{t("盯住每个客户：今天该联系谁、为什么、下一步做什么。")}</p>
        </div>
        <div className="de-opportunity-header-actions">
          {onOpenChat && (
            <button type="button" className="de-secondary-button" onClick={onOpenChat}>
              {t("与商机雷达对话")}
            </button>
          )}
          <button className="de-primary-button" disabled={discovering} onClick={() => void discover()}>
            {discovering ? t("发现中 {0}%", [discoverProgress]) : t("✦ 发现新商机")}
          </button>
          <button
            className="de-secondary-button"
            onClick={() => {
              setActive(null);
              setDialog("create");
            }}
          >
            {t("手动添加行动")}
          </button>
        </div>
      </header>

      {data && <Summary summary={data.summary} />}
      {data && <Automation settings={data.settings} lastDiscoveredAt={data.lastDiscoveredAt} saving={savingSettings} onSave={saveSettings} />}
      {error && (
        <div className="de-inline-error" role="alert">
          <span>{t(error)}</span>
          <button onClick={() => setError(null)}>{t("关闭")}</button>
        </div>
      )}
      {discoverNotice && (
        <div className="de-inline-notice" role="status">
          <span>{t(discoverNotice)}</span>
          <button onClick={() => setDiscoverNotice(null)}>{t("关闭")}</button>
        </div>
      )}

      <div className="de-opportunity-tabs" role="tablist">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={view === item.id}
            className={view === item.id ? "active" : ""}
            onClick={() => setView(item.id)}
          >
            {t(item.label)}
            {counts && <b>{counts[item.id]}</b>}
          </button>
        ))}
      </div>

      <OpportunityFilters values={filters} onChange={setFilters} />

      {loading ? (
        <div className="de-state">{t("正在读取客户经营事项…")}</div>
      ) : !data?.items.length ? (
        <Empty
          view={view}
          hasProfiles={data?.hasProfiles ?? false}
          hasFilters={Object.values(filters).some(Boolean)}
          onCreateProfile={onCreateProfile}
          onDiscover={() => void discover()}
        />
      ) : (
        <section className="de-opportunity-list" aria-label={VIEWS.find((item) => item.id === view)?.label}>
          {data.items.map((item) => (
            <OpportunityCard
              key={item.id}
              item={item}
              onOpenProfile={onOpenProfile}
              onAction={openDialog}
              onResume={() => void mutate(() => employeeApi.decideOpportunity(item.opportunityId, { decision: "resume" }))}
              onExecute={() =>
                void mutate(() => employeeApi.updateOpportunityAction(item.actionId!, { operation: "execute", version: item.actionVersion }))
              }
              onCancel={() =>
                void mutate(() =>
                  employeeApi.updateOpportunityAction(item.actionId!, { operation: "cancel", reason: "user_cancelled", version: item.actionVersion })
                )
              }
            />
          ))}
        </section>
      )}

      {active && dialog === "accept" && (
        <AcceptDialog
          item={active}
          onClose={closeDialog}
          onSave={(input) => void mutate(() => employeeApi.decideOpportunity(active.opportunityId, { decision: "accept", ...input }))}
        />
      )}
      {active && dialog === "snooze" && (
        <SnoozeDialog
          onClose={closeDialog}
          onSave={(snoozedUntil) => {
            void (async () => {
              setError(null);
              try {
                await employeeApi.decideOpportunity(active.opportunityId, { decision: "snooze", snoozedUntil });
                closeDialog();
                setView("snoozed");
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "操作失败");
              }
            })();
          }}
        />
      )}
      {active && dialog === "dismiss" && (
        <DismissDialog
          onClose={closeDialog}
          onSave={(reason) => {
            if (reason === "信息不准确") {
              const profileId = active.profileId;
              void mutate(() => employeeApi.decideOpportunity(active.opportunityId, { decision: "dismiss", reason })).then(() =>
                onOpenProfile(profileId)
              );
              return;
            }
            void mutate(() => employeeApi.decideOpportunity(active.opportunityId, { decision: "dismiss", reason }));
          }}
        />
      )}
      {active && dialog === "reschedule" && (
        <RescheduleDialog
          item={active}
          onClose={closeDialog}
          onSave={(scheduledAt) =>
            void mutate(() =>
              employeeApi.updateOpportunityAction(active.actionId!, { operation: "reschedule", scheduledAt, version: active.actionVersion })
            )
          }
        />
      )}
      {active && dialog === "result" && (
        <ResultDialog
          item={active}
          onClose={closeDialog}
          onSave={(input) => void mutate(() => employeeApi.addOpportunityActionResult(active.actionId!, input))}
        />
      )}
      {dialog === "create" && (
        <CreateActionDialog
          onClose={closeDialog}
          onSave={(input) =>
            void mutate(async () => {
              await employeeApi.createOpportunityAction(input);
              setView("in_progress");
            })
          }
        />
      )}
    </div>
  );
}

function Summary({ summary }: { summary: OpportunityListResponse["summary"] }) {
  const { t } = useI18n();
  return <section className="de-opportunity-summary" aria-label={t("商机汇总")}>
    <div><span>{t("今日待跟进")}</span><strong>{summary.dueToday}</strong></div>
    <div className="overdue"><span>{t("逾期行动")}</span><strong>{summary.overdue}</strong></div>
    <div className="high"><span>{t("高优先新商机")}</span><strong>{summary.highPriority}</strong></div>
    <div><span>{t("待回填结果")}</span><strong>{summary.awaitingResult}</strong></div>
  </section>;
}

function Automation({ settings, lastDiscoveredAt, saving, onSave }: { settings: OpportunitySettings; lastDiscoveredAt: string | null; saving: boolean; onSave: (value: OpportunitySettings) => void }) {
  const { t, locale } = useI18n();
  return (
    <section className="de-opportunity-automation">
      <span>
        {t("最近发现：")}
        <strong>{lastDiscoveredAt ? formatTime(lastDiscoveredAt, locale) : t("尚未运行")}</strong>
      </span>
      <label className="de-switch">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={saving}
          onChange={(event) => onSave({ ...settings, enabled: event.target.checked, discoveryMode: "hybrid" })}
        />
        <i />
        <span>{t("每日自动发现")}</span>
      </label>
      <label>
        <span>{t("执行时间")}</span>
        <input
          type="time"
          value={settings.dailyRunTime}
          disabled={!settings.enabled || saving}
          onChange={(event) => onSave({ ...settings, dailyRunTime: event.target.value })}
        />
      </label>
      <small>
        {settings.enabled && settings.nextRunAt ? t("下次 {0}", [formatTime(settings.nextRunAt, locale)]) : t("默认关闭，不会产生模型费用")}
      </small>
    </section>
  );
}

function Empty({ view, hasProfiles, hasFilters, onCreateProfile, onDiscover }: { view: OpportunityView; hasProfiles: boolean; hasFilters: boolean; onCreateProfile: () => void; onDiscover: () => void }) {
  const { t } = useI18n();
  const content = !hasProfiles ? ["还没有可经营的客户画像", "商机雷达只围绕已建档的单个客户工作，请先建立客户画像。"] : hasFilters ? ["没有符合筛选条件的客户事项", "清除或调整筛选条件后再看。"] : view === "today" ? ["今天没有必须处理的客户事项", "可以查看待判断商机，或手动安排一次回访和维护。"] : view === "pending" ? ["当前没有需要判断的新商机", "可以立即运行一次发现；确定性提醒仍会按计划出现在今日经营。"] : view === "snoozed" ? ["稍后处理队列为空", "在「待判断」里点「稍后」的商机会出现在这里，到期后自动回到待判断。"] : ["这个视图目前为空", "行动采纳、执行和结果回填后会自动流转到对应视图。"];
  return <div className="de-state de-empty-state de-opportunity-empty"><span className="de-empty-icon">◇</span><strong>{t(content[0])}</strong><p>{t(content[1])}</p>{!hasProfiles ? <button className="de-primary-button" onClick={onCreateProfile}>{t("新建客户")}</button> : view === "pending" && <button className="de-secondary-button" onClick={onDiscover}>{t("发现新商机")}</button>}</div>;
}
