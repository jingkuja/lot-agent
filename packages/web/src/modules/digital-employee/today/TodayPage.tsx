import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import { useI18n } from "../../../i18n/index.js";
import { DeploymentManager } from "../acquisition/DeploymentManager.js";
import { employeeApi } from "../api.js";
import { formatTime, type OpportunityDialog } from "../opportunities/OpportunityCard.js";
import { CreateActionDialog, OpportunityDialogs } from "../opportunities/OpportunityDialogs.js";
import { TODAY_PATH } from "../routes.js";
import type { CampaignRecommendation, MarketingAsset, OpportunityItem, TodayItem, TodayResponse } from "../types.js";
import { proposalCopy, runningLabel } from "./copy.js";

const QUICK_RESULTS = [
  { outcome: "replied", label: "已回复" },
  { outcome: "interested", label: "有兴趣" },
  { outcome: "no_response", label: "无响应" },
] as const;

interface TodayPageProps {
  data: TodayResponse | null;
  error: string | null;
  busy: boolean;
  onReload: () => Promise<void> | void;
  onOpenConversation: (id: string) => void;
  onOpenProfile: (id: string) => void;
  onOpenCustomers: () => void;
  onOpenSnoozed: () => void;
  onOpenLink: (url: string) => void;
  onDraftOutreach: (item: OpportunityItem) => void;
  onAssign: (prompt: string) => void;
  onRefineRecommendation: (item: CampaignRecommendation) => void;
}

interface Notice {
  text: string;
  link?: string | null;
}

/** The landing page: what the employee prepared, in the order the owner has to act on it. */
export function TodayPage({
  data, error, busy, onReload, onOpenConversation, onOpenProfile, onOpenCustomers, onOpenSnoozed, onOpenLink,
  onDraftOutreach, onAssign, onRefineRecommendation,
}: TodayPageProps) {
  const { t, locale } = useI18n();
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [active, setActive] = useState<OpportunityItem | null>(null);
  const [dialog, setDialog] = useState<OpportunityDialog | null>(null);
  const [creating, setCreating] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [reporting, setReporting] = useState<MarketingAsset | null>(null);

  const unreadBrief = data?.brief && !data.brief.readAt ? data.brief.id : null;
  useEffect(() => {
    if (unreadBrief) void employeeApi.markBriefRead(unreadBrief).catch(() => {});
  }, [unreadBrief]);

  const closeDialog = () => { setActive(null); setDialog(null); setCreating(false); };
  const openDialog = (item: OpportunityItem, next: OpportunityDialog) => { setActive(item); setDialog(next); };

  /** One click, one write: the card stays disabled until the server answers. */
  const act = async (key: string, operation: () => Promise<Notice | void>) => {
    setPending(key); setActionError(null); setNotice(null);
    try {
      const result = await operation();
      if (result) setNotice(result);
      closeDialog();
      await onReload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setPending(null);
    }
  };
  const mutate = (operation: () => Promise<unknown>) => act("dialog", async () => { await operation(); });

  const scan = async () => {
    if (scanning) return;
    setScanning(true); setActionError(null);
    try {
      await employeeApi.discoverOpportunities();
      await onReload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setScanning(false);
    }
  };

  if (!data) {
    return <div className="de-page de-today">{error
      ? <div className="de-inline-error" role="alert"><span>{t(error)}</span><button onClick={() => void onReload()}>{t("重试")}</button></div>
      : <div className="de-state">{t("加载中…")}</div>}
    </div>;
  }

  const proposals = data.items.filter((item) => item.kind === "proposal");
  const opportunities = data.items.filter((item) => item.kind === "opportunity");
  const recommendations = data.items.filter((item) => item.kind === "recommendation");
  const followUps = data.items.filter((item) => item.kind === "follow_up");
  const results = data.items.filter((item) => item.kind === "result");
  const toConfirm = proposals.length + opportunities.length + recommendations.length;

  return (
    <div className="de-page de-today">
      <section className="de-today-brief">
        <div>
          <h1>{t("今日简报")}</h1>
          <p>
            {data.hasProfiles
              ? t("待确认 {0} 件，要跟进 {1} 位客户，等结果 {2} 个。", [toConfirm, followUps.length, results.length])
              : t("我还不认识你的客户。告诉我第一位客户，我就开始准备工作。")}
          </p>
          {data.brief && <p>{t("今天看了 {0} 位客户，新发现 {1} 条商机。", [data.brief.counts.scanned, data.brief.counts.created])}</p>}
          {data.lastDiscoveredAt && <small>{t("最近看过客户：{0}", [formatTime(data.lastDiscoveredAt, locale)])}</small>}
        </div>
        {data.hasProfiles ? (
          <button type="button" className="de-secondary-button" disabled={scanning} onClick={() => void scan()}>
            {t("再看一遍")}
          </button>
        ) : (
          <div className="de-today-brief-actions">
            <button
              type="button"
              className="de-primary-button"
              disabled={busy}
              onClick={() => onAssign(t("我要记录第一位客户，请问我需要告诉你什么？"))}
            >
              {t("告诉员工")}
            </button>
            <button type="button" className="de-secondary-button" onClick={onOpenCustomers}>
              {t("新建客户")}
            </button>
          </div>
        )}
      </section>

      {actionError && (
        <div className="de-inline-error" role="alert">
          <span>{t(actionError)}</span>
          <button onClick={() => setActionError(null)}>{t("关闭")}</button>
        </div>
      )}
      {notice && (
        <div className="de-inline-notice" role="status">
          <span>{t(notice.text)}</span>
          {notice.link && <button onClick={() => onOpenLink(notice.link!)}>{t("查看")}</button>}
        </div>
      )}

      {toConfirm > 0 && (
        <section className="de-today-section de-today-confirm" aria-label={t("需要你确认")}>
          <h2>
            {t("需要你确认")}
            <b>{toConfirm}</b>
          </h2>
          {proposals.map((item) => {
            const proposal = item.proposal!;
            const copy = proposalCopy(item, t);
            const disabled = pending !== null;
            const conversationId = proposal.conversationId;
            return (
              <article key={item.id} className="de-today-card">
                <div>
                  <h3>{copy.title}</h3>
                  {copy.detail && <p>{copy.detail}</p>}
                </div>
                <div className="de-today-actions">
                  {proposal.confirmable && (
                    <button
                      type="button"
                      className="de-primary-button"
                      disabled={disabled}
                      onClick={() =>
                        void act(item.id, async () => {
                          const result = await employeeApi.confirmProposal(proposal.id);
                          return {
                            text: result.alreadyApplied ? "这项之前已经确认过了" : "已确认",
                            link: result.managementUrl === TODAY_PATH ? null : result.managementUrl,
                          };
                        })
                      }
                    >
                      {pending === item.id ? t("处理中…") : t("确认")}
                    </button>
                  )}
                  {conversationId && (
                    <button type="button" className="de-secondary-button" onClick={() => onOpenConversation(conversationId)}>
                      {proposal.confirmable ? t("修改") : t("去对话里选择")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="de-quiet-button"
                    disabled={disabled}
                    onClick={() =>
                      void act(item.id, async () => {
                        await employeeApi.dismissProposal(proposal.id);
                      })
                    }
                  >
                    {t("不做")}
                  </button>
                </div>
              </article>
            );
          })}
          {opportunities.map((item) => (
            <WorkCard key={item.id} item={item} locale={locale}>
              <button
                type="button"
                className="de-primary-button"
                disabled={item.opportunity!.riskFlags.some((risk) => risk.blocking)}
                onClick={() => openDialog(item.opportunity!, "accept")}
              >
                {t("采纳")}
              </button>
              <button type="button" className="de-secondary-button" disabled={busy} onClick={() => onDraftOutreach(item.opportunity!)}>
                {t("写话术")}
              </button>
              <button type="button" className="de-secondary-button" onClick={() => openDialog(item.opportunity!, "snooze")}>
                {t("稍后")}
              </button>
              <button type="button" className="de-quiet-button" onClick={() => openDialog(item.opportunity!, "dismiss")}>
                {t("不做")}
              </button>
            </WorkCard>
          ))}
          {recommendations.map((item) => (
            <article key={item.id} className="de-today-card">
              <div>
                <h3>{t("活动提议：{0}", [item.title])}</h3>
                <p>{item.reason}</p>
                {item.evidence.length > 0 && (
                  <p className="de-today-evidence">
                    {t("依据：")}
                    {item.evidence.map((entry) => entry.fact).join("；")}
                  </p>
                )}
              </div>
              <div className="de-today-actions">
                <button
                  type="button"
                  className="de-primary-button"
                  disabled={busy}
                  onClick={() => onAssign(t("按这条提议准备一个活动：{0}", [item.title]))}
                >
                  {t("开工")}
                </button>
                <button type="button" className="de-secondary-button" onClick={() => onRefineRecommendation(item.recommendation!)}>
                  {t("修改")}
                </button>
                <button
                  type="button"
                  className="de-quiet-button"
                  disabled={pending !== null}
                  onClick={() =>
                    void act(item.id, async () => {
                      await employeeApi.updateAcquisitionRecommendation(item.source.id, "ignored");
                    })
                  }
                >
                  {t("不做")}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {(data.hasProfiles || followUps.length > 0) && (
        <section className="de-today-section" aria-label={t("今天要跟进")}>
          <h2>
            {t("今天要跟进")}
            {followUps.length > 0 && <b>{followUps.length}</b>}
            <span className="de-today-section-links">
              {data.snoozedCount > 0 && (
                <button type="button" onClick={onOpenSnoozed}>
                  {t("稍后处理 {0}", [data.snoozedCount])}
                </button>
              )}
              <button type="button" onClick={() => setCreating(true)}>
                {t("手动添加行动")}
              </button>
            </span>
          </h2>
          {followUps.length === 0 && <p className="de-today-empty">{t("今天没有要跟进的客户。")}</p>}
          {followUps.map((item) => {
            const opportunity = item.opportunity!;
            return (
              <WorkCard key={item.id} item={item} locale={locale}>
                <button type="button" className="de-primary-button" disabled={busy} onClick={() => onDraftOutreach(opportunity)}>
                  {t("写话术")}
                </button>
                <button
                  type="button"
                  className="de-secondary-button"
                  disabled={pending !== null}
                  onClick={() =>
                    void act(item.id, async () => {
                      await employeeApi.updateOpportunityAction(opportunity.actionId!, { operation: "execute", version: opportunity.actionVersion });
                    })
                  }
                >
                  {t("已联系")}
                </button>
                <button type="button" className="de-secondary-button" onClick={() => openDialog(opportunity, "reschedule")}>
                  {t("改时间")}
                </button>
                <button type="button" className="de-quiet-button" onClick={() => onOpenProfile(opportunity.profileId)}>
                  {t("查看客户")}
                </button>
              </WorkCard>
            );
          })}
        </section>
      )}

      {results.length > 0 && (
        <section className="de-today-section" aria-label={t("等你告诉我结果")}>
          <h2>
            {t("等你告诉我结果")}
            <b>{results.length}</b>
          </h2>
          {results.map((item) => {
            if (item.deployment) {
              const { deployment } = item;
              return (
                <article key={item.id} className="de-today-card">
                  <div>
                    <h3>{t("{0} 投放满 3 天了，效果怎么样？", [deployment.title])}</h3>
                    {deployment.deployedAt && <small>{formatTime(deployment.deployedAt, locale)}</small>}
                  </div>
                  <div className="de-today-actions">
                    <button
                      type="button"
                      className="de-primary-button"
                      disabled={pending !== null}
                      onClick={() => void act(item.id, async () => { setReporting(await employeeApi.getMarketingAsset(deployment.assetId)); })}
                    >{t("回填效果")}</button>
                  </div>
                </article>
              );
            }
            const opportunity = item.opportunity!;
            return (
              <WorkCard key={item.id} item={item} locale={locale}>
                {QUICK_RESULTS.map((result) => (
                  <button
                    key={result.outcome}
                    type="button"
                    className="de-secondary-button"
                    disabled={pending !== null}
                    onClick={() =>
                      void act(item.id, async () => {
                        await employeeApi.addOpportunityActionResult(opportunity.actionId!, { outcome: result.outcome });
                      })
                    }
                  >
                    {t(result.label)}
                  </button>
                ))}
                <button type="button" className="de-quiet-button" onClick={() => openDialog(opportunity, "result")}>
                  {t("更多")}
                </button>
              </WorkCard>
            );
          })}
        </section>
      )}

      {data.running.length > 0 && (
        <section className="de-today-section" aria-label={t("我正在做")}>
          <h2>{t("我正在做")}</h2>
          {data.running.map((work) => (
            <article key={work.id} className="de-today-running">
              <span>{t(runningLabel(work.type))}</span>
              <i aria-hidden>
                <em style={{ width: `${Math.max(4, work.progress)}%` }} />
              </i>
              <button
                type="button"
                className="de-quiet-button"
                disabled={pending !== null}
                onClick={() =>
                  void act(work.id, async () => {
                    await api.cancelTask(work.id);
                  })
                }
              >
                {t("取消")}
              </button>
            </article>
          ))}
        </section>
      )}

      {data.hasProfiles && data.items.length === 0 && data.running.length === 0 && <p className="de-today-empty">{t("今天的工作都处理完了。")}</p>}

      <OpportunityDialogs active={active} dialog={dialog} onClose={closeDialog} mutate={mutate} onOpenProfile={onOpenProfile} />
      {reporting && <DeploymentManager
        asset={reporting}
        onClose={() => setReporting(null)}
        onChanged={() => {
          setReporting(null);
          void onReload();
        }}
      />}
      {creating && <CreateActionDialog onClose={closeDialog} onSave={(input) => void mutate(() => employeeApi.createOpportunityAction(input))} />}
    </div>
  );
}

function WorkCard({ item, locale, children }: { item: TodayItem; locale: string; children: React.ReactNode }) {
  const { t } = useI18n();
  const opportunity = item.opportunity!;
  return <article className={`de-today-card ${opportunity.overdue ? "is-overdue" : ""}`}>
    <div>
      <h3>{item.subject?.label}{t("：")}{item.title}</h3>
      {item.reason && <p>{item.reason}</p>}
      {item.evidence.length > 0 && <p className="de-today-evidence">{t("依据：")}{item.evidence.map((entry) => entry.fact).join("；")}</p>}
      {item.dueAt && <small>{opportunity.overdue ? t("已逾期 · ") : ""}{formatTime(item.dueAt, locale)}</small>}
      {opportunity.riskFlags.map((risk) => <p key={risk.code} className="de-today-risk">{risk.message}</p>)}
    </div>
    <div className="de-today-actions">{children}</div>
  </article>;
}
