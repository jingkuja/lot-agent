import { useCallback, useEffect, useState } from "react";
import type { Conversation } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { employeeApi } from "./api.js";
import {
  EMPTY_FILTERS, OpportunityCard, OpportunityFilters, formatTime,
  type FilterValues, type OpportunityDialog,
} from "./opportunities/OpportunityCard.js";
import { OpportunityDialogs } from "./opportunities/OpportunityDialogs.js";
import { TEMPLATE_LABELS } from "./schedule/labels.js";
import { runSummary } from "./schedule/ScheduledRunPage.js";
import type { OpportunityItem, OpportunityListResponse, OpportunityView, ScheduleRun } from "./types.js";

type WorkTab = "conversations" | "scheduled" | Extract<OpportunityView, "in_progress" | "completed" | "snoozed">;

const TABS: Array<{ id: WorkTab; label: string }> = [
  { id: "conversations", label: "对话" },
  { id: "in_progress", label: "跟进中" },
  { id: "completed", label: "已完成" },
  { id: "snoozed", label: "稍后处理" },
  { id: "scheduled", label: "定时工作" },
];

interface WorkLogPageProps {
  /** The tab a link asked for. */
  initialTab: string | null;
  schedules: boolean;
  onOpenScheduledRun: (id: string) => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Rows open the record of the work; the record leads back to the conversation. */
  onOpenWork: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onOpenProfile: (id: string) => void;
  onDraftOutreach: (item: OpportunityItem) => void;
}

/** Everything the employee and the owner did together, not split by module. */
export function WorkLogPage(props: WorkLogPageProps) {
  const { t } = useI18n();
  const tabs = TABS.filter((item) => item.id !== "scheduled" || props.schedules);
  const [tab, setTab] = useState<WorkTab>(tabs.find((item) => item.id === props.initialTab)?.id ?? "conversations");
  return <div className="de-page de-work-log">
    <header className="de-employee-page-head"><h1>{t("工作记录")}</h1></header>
    <nav className="de-employee-tabs" aria-label={t("工作记录")}>
      {tabs.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{t(item.label)}</button>)}
    </nav>
    {tab === "conversations" && <ConversationList {...props} />}
    {tab === "scheduled" && <ScheduledRuns onOpen={props.onOpenScheduledRun} />}
    {tab !== "conversations" && tab !== "scheduled" && <FollowUpList view={tab} onOpenProfile={props.onOpenProfile} onDraftOutreach={props.onDraftOutreach} />}
  </div>;
}

/** Skipped and missed runs stay listed: they answer why a report did not appear. */
function ScheduledRuns({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, locale } = useI18n();
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void employeeApi.listSchedules()
      .then((result) => { if (live) setRuns(result.runs); })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "读取失败"); });
    return () => { live = false; };
  }, []);
  if (error) return <div className="de-inline-error" role="alert"><span>{t(error)}</span></div>;
  if (!runs) return <div className="de-state">{t("加载中…")}</div>;
  if (runs.length === 0) return <div className="de-state de-empty-state"><strong>{t("还没有定时工作记录")}</strong></div>;
  return <section className="de-work-log-list">
    {runs.map((run) => <article key={run.id}>
      <button type="button" onClick={() => onOpen(run.id)}>
        <strong>{t(TEMPLATE_LABELS[run.template])} · {runSummary(run, t)}</strong>
        <small>{formatTime(run.scheduledFor, locale)}</small>
      </button>
    </article>)}
  </section>;
}

function ConversationList({
  conversations, activeConversationId, hasMore, loadingMore, onLoadMore, onOpenWork, onDeleteConversation,
}: WorkLogPageProps) {
  const { t, locale } = useI18n();
  if (conversations.length === 0) return <div className="de-state de-empty-state"><strong>{t("还没有工作记录")}</strong></div>;
  return <section className="de-work-log-list">
    {conversations.map((conversation) => <article key={conversation.id} className={conversation.id === activeConversationId ? "active" : ""}>
      <button type="button" onClick={() => onOpenWork(conversation.id)}>
        <strong>{conversation.title || t("新对话")}</strong>
        <small>{conversation.updated_at ? formatTime(conversation.updated_at, locale) : ""}</small>
      </button>
      <button type="button" className="de-work-log-delete" aria-label={t("删除对话")} onClick={() => onDeleteConversation(conversation.id)}>×</button>
    </article>)}
    {hasMore && <button className="de-secondary-button" disabled={loadingMore} onClick={onLoadMore}>{t("加载更多")}</button>}
  </section>;
}

function FollowUpList({ view, onOpenProfile, onDraftOutreach }: {
  view: OpportunityView;
  onOpenProfile: (id: string) => void;
  onDraftOutreach: (item: OpportunityItem) => void;
}) {
  const { t } = useI18n();
  const [filters, setFilters] = useState<FilterValues>(EMPTY_FILTERS);
  const [data, setData] = useState<OpportunityListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<OpportunityItem | null>(null);
  const [dialog, setDialog] = useState<OpportunityDialog | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await employeeApi.listOpportunities({ view, ...filters })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取失败"); }
  }, [view, filters]);
  useEffect(() => { void load(); }, [load]);

  const close = () => { setActive(null); setDialog(null); };
  const mutate = async (operation: () => Promise<unknown>) => {
    setError(null);
    try { await operation(); close(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
  };

  return <>
    <OpportunityFilters values={filters} onChange={setFilters} />
    {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span><button onClick={() => void load()}>{t("重试")}</button></div>}
    {!data ? <div className="de-state">{t("正在读取客户经营事项…")}</div> : data.items.length === 0
      ? <div className="de-state de-empty-state"><strong>{t("这个视图目前为空")}</strong></div>
      : <section className="de-opportunity-list">
        {data.items.map((item) => <OpportunityCard
          key={item.id}
          item={item}
          onOpenProfile={onOpenProfile}
          onDraftOutreach={onDraftOutreach}
          onAction={(next, action) => { setActive(next); setDialog(action); }}
          onResume={() => void mutate(() => employeeApi.decideOpportunity(item.opportunityId, { decision: "resume" }))}
          onExecute={() => void mutate(() => employeeApi.updateOpportunityAction(item.actionId!, { operation: "execute", version: item.actionVersion }))}
          onCancel={() => void mutate(() => employeeApi.updateOpportunityAction(item.actionId!, { operation: "cancel", reason: "user_cancelled", version: item.actionVersion }))}
        />)}
      </section>}
    <OpportunityDialogs active={active} dialog={dialog} onClose={close} mutate={mutate} onOpenProfile={onOpenProfile} />
  </>;
}
