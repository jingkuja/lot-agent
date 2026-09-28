import { useI18n } from "../../i18n/index.js";
import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import {
  HEALTH_LABELS,
  RELATIONSHIP_LABELS,
  type CustomerProfile,
  type DigitalEmployeeOverview,
} from "./types.js";

interface DigitalEmployeeHomeProps {
  onOpenProfiles: () => void;
  onOpenProfile: (profileId: string) => void;
  onOpenOpportunities?: () => void;
  onOpenAcquisition?: () => void;
  onPrompt: (prompt: string) => void;
  llmModelId?: string | null;
}

const QUICK_PROMPTS = [
  { label: "查看风险客户", prompt: "请查找当前健康度有风险的客户，概括每位客户的风险点。" },
  { label: "记录客户动态", prompt: "我要记录一条新的客户动态，请引导我补全客户、事件和产品信息。" },
];

export function DigitalEmployeeHome({ onOpenProfiles, onOpenProfile, onOpenOpportunities, onOpenAcquisition, onPrompt, llmModelId }: DigitalEmployeeHomeProps) {
  const { t, locale } = useI18n();
  const [overview, setOverview] = useState<DigitalEmployeeOverview | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.getDigitalEmployeeOverview()
      .then((result) => {
        if (active) setOverview(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => { active = false; };
  }, []);

  const refreshCohort = async () => {
    if (!llmModelId || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const cohort = await api.refreshDigitalEmployeeCohort(llmModelId);
      setOverview((current) => current ? { ...current, cohort } : current);
    } catch (requestError) {
      setRefreshError(requestError instanceof Error ? requestError.message : "群像总结更新失败，请稍后重试");
    } finally {
      setRefreshing(false);
    }
  };

  const toggleCohortSchedule = async (enabled: boolean) => {
    if (!overview || savingSchedule) return;
    setSavingSchedule(true);
    setScheduleError(null);
    try {
      const schedule = await api.saveDigitalEmployeeCohortSchedule({
        enabled,
        version: overview.schedule.version,
      });
      setOverview((current) => current ? { ...current, schedule } : current);
    } catch (requestError) {
      setScheduleError(requestError instanceof Error ? requestError.message : "自动更新设置保存失败");
    } finally {
      setSavingSchedule(false);
    }
  };

  return (
    <section className="de-home" aria-label={t("客户洞察工作台")}>
      <header className="de-home-header">
        <div className="de-home-heading">
          <span className="de-home-mark" aria-hidden><PortraitIcon /></span>
          <div>
            <p className="de-home-eyebrow">{t("客户洞察工作台")}</p>
            <h1>{t("从客户动态开始今天的工作")}</h1>
            <p>{t("快速查看群像变化与最近客户，也可以直接用对话查询、更新或记录画像。")}</p>
          </div>
        </div>
        <label
          className="de-home-schedule de-switch"
          title={overview?.schedule.enabled ? t("已开启：群像总结每天 23:00（北京时间）自动生成，并产生模型费用") : t("默认关闭；开启后群像总结将在每天 23:00（北京时间）自动生成")}
        >
          <input
            type="checkbox"
            checked={overview?.schedule.enabled ?? false}
            disabled={!overview || savingSchedule}
            onChange={(event) => void toggleCohortSchedule(event.target.checked)}
          />
          <i aria-hidden />
          <span><strong>{t("群像总结")}</strong> {overview?.schedule.enabled ? t("每晚 23:00 自动更新") : t("自动更新已关闭")}</span>
        </label>
      </header>

      {scheduleError && <p className="de-cohort-refresh-error" role="alert">{t(scheduleError)}</p>}

      <div className="de-home-grid">
        <article className="de-cohort-card">
          <div className="de-home-card-heading">
            <div>
              <p className="de-home-card-kicker">{t("客户群像")}</p>
              <h2>{t("整体客户脉搏")}</h2>
            </div>
            <div className="de-cohort-heading-actions">
              {overview && (
                <span className="de-cohort-source">
                  {overview.cohort.source === "live" ? t("实时规则预览") : overview.cohort.generationMethod === "llm" ? t("AI 智能总结 · {0}", [dateTime(overview.cohort.generatedAt, locale)]) : t("规则兜底 · {0}", [dateTime(overview.cohort.generatedAt, locale)])}
                </span>
              )}
              <button
                className="de-cohort-refresh"
                type="button"
                onClick={() => void refreshCohort()}
                disabled={refreshing || !llmModelId || !overview}
                title={llmModelId ? t("使用当前模型 {0} 更新", [llmModelId]) : t("当前没有可用的 LLM 模型")}
              >
                {refreshing ? t("更新中…") : t("即刻更新")}
              </button>
            </div>
          </div>

          {refreshError && <p className="de-cohort-refresh-error" role="alert">{t(refreshError)}</p>}

          {!overview && !error && <CohortSkeleton />}
          {error && (
            <div className="de-home-inline-state">
              <p>{t("群像总结暂时无法读取，你仍可继续使用对话。")}</p>
            </div>
          )}
          {overview && (
            <>
              <p className="de-cohort-summary">{overview.cohort.summary}</p>
              <div className="de-cohort-metrics">
                <Metric value={overview.cohort.metrics.totalProfiles} label={t("客户总数")} tone="primary" />
                <Metric value={overview.cohort.metrics.activeLast7Days} label={t("近 7 天活跃")} tone="positive" />
                <Metric value={overview.cohort.metrics.dueFollowUps} label={t("待跟进")} tone="warning" />
              </div>
              <div className="de-cohort-breakdown">
                <div>
                  <span>{t("关系构成")}</span>
                  <div className="de-cohort-chips">
                    {overview.cohort.metrics.relationshipStages.slice(0, 3).map((item) => (
                      <span key={item.key}>{t(item.label)}<strong>{item.count}</strong></span>
                    ))}
                    {overview.cohort.metrics.relationshipStages.length === 0 && <em>{t("暂无数据")}</em>}
                  </div>
                </div>
                <div>
                  <span>{t("高频标签")}</span>
                  <div className="de-cohort-chips">
                    {overview.cohort.metrics.topTags.slice(0, 3).map((item) => (
                      <span key={item.key}>{t(item.label)}<strong>{item.count}</strong></span>
                    ))}
                    {overview.cohort.metrics.topTags.length === 0 && <em>{t("暂无标签")}</em>}
                  </div>
                </div>
              </div>
            </>
          )}
        </article>

        <article className="de-recent-card">
          <div className="de-home-card-heading">
            <div>
              <p className="de-home-card-kicker">{t("最近更新")}</p>
              <h2>{t("客户画像")}</h2>
            </div>
            <div className="de-recent-heading-actions">
              <button
                type="button"
                className="de-recent-create"
                onClick={() => {
                  try { sessionStorage.setItem("de-profile-create", "1"); } catch { /* ignore */ }
                  onOpenProfiles();
                }}
              >
                <span aria-hidden>＋</span> {t("新建画像")}</button>
              <button type="button" className="de-recent-all" onClick={onOpenProfiles}>{t("全部画像")}<span aria-hidden>→</span></button>
            </div>
          </div>

          {!overview && !error && <RecentSkeleton />}
          {overview && overview.recentProfiles.length === 0 && (
            <button
              className="de-recent-empty"
              type="button"
              onClick={() => {
                try { sessionStorage.setItem("de-profile-create", "1"); } catch { /* ignore */ }
                onOpenProfiles();
              }}
            >
              <span aria-hidden>＋</span>
              <strong>{t("创建第一位客户")}</strong>
              <small>{t("手工新建，或直接在下方对话中记录")}</small>
            </button>
          )}
          {overview && overview.recentProfiles.length > 0 && (
            <div className="de-recent-list">
              {overview.recentProfiles.slice(0, 4).map((profile) => (
                <ProfileRow key={profile.id} profile={profile} onOpen={() => onOpenProfile(profile.id)} />
              ))}
            </div>
          )}
          {error && <div className="de-home-inline-state"><p>{t("最近画像暂时无法读取。")}</p></div>}
        </article>
      </div>

      <div className="de-quick-prompts" aria-label={t("客户工作快捷操作")}>
        <span>{t("快捷开始")}</span>
        <button type="button" onClick={() => onOpenOpportunities ? onOpenOpportunities() : onPrompt("请查询已到跟进时间或近期需要关注的客户，并按优先级给我建议。") }>
          {t("进入今日经营")}<span aria-hidden>↗</span>
        </button>
        <button type="button" onClick={() => onOpenAcquisition ? onOpenAcquisition() : onPrompt("请总结整体客群的共同需求和差异，并建议适合建立的营销客群。") }>
          {t("进入获客宝分析")}<span aria-hidden>↗</span>
        </button>
        {QUICK_PROMPTS.map((item) => (
          <button key={item.label} type="button" onClick={() => onPrompt(t(item.prompt))}>
            {t(item.label)}<span aria-hidden>↗</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Metric({ value, label, tone }: { value: number; label: string; tone: string }) {
  const { t } = useI18n();
  return <div className={`de-cohort-metric ${tone}`}><strong>{value}</strong><span>{t(label)}</span></div>;
}

function ProfileRow({ profile, onOpen }: { profile: CustomerProfile; onOpen: () => void }) {
  const { t, locale } = useI18n();
  return (
    <button className="de-recent-row" type="button" onClick={onOpen}>
      <span className="de-recent-avatar" aria-hidden>{profile.displayName.trim().slice(0, 1).toUpperCase()}</span>
      <span className="de-recent-main">
        <span><strong>{profile.displayName}</strong><small>{t(relativeTime(profile.updatedAt, locale))}</small></span>
        <span>{profile.organization || profile.customerRegion || profile.summary || t("待补充客户信息")}</span>
      </span>
      <span className={`de-recent-health health-${profile.overallHealth}`}>
        {profile.overallHealth === "healthy" ? t(RELATIONSHIP_LABELS[profile.relationshipStage]) : t(HEALTH_LABELS[profile.overallHealth])}
      </span>
    </button>
  );
}

function CohortSkeleton() {
  const { t } = useI18n();
  return <div className="de-home-skeleton de-home-skeleton--cohort" aria-label={t("正在读取客户群像")}><i /><i /><div><i /><i /><i /></div></div>;
}

function RecentSkeleton() {
  const { t } = useI18n();
  return <div className="de-home-skeleton de-home-skeleton--recent" aria-label={t("正在读取最近客户")}><i /><i /><i /></div>;
}

function dateTime(value: string, locale = "zh-CN"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "最近";
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function relativeTime(value: string, locale = "zh-CN"): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "最近";
  const delta = Date.now() - time;
  if (delta < 60 * 60 * 1_000) return "刚刚";
  if (delta < 24 * 60 * 60 * 1_000) return `${Math.max(1, Math.floor(delta / (60 * 60 * 1_000)))} 小时前`;
  if (delta < 7 * 24 * 60 * 60 * 1_000) return `${Math.floor(delta / (24 * 60 * 60 * 1_000))} 天前`;
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(new Date(time));
}

function PortraitIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="8" cy="9" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 18c.7-3 2.2-4.5 4.5-4.5s3.8 1.5 4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="16.5" cy="8" r="2.3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14 13.2c.8-.7 1.7-1 2.7-1 2 0 3.3 1.3 3.8 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
