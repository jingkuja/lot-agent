import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import { formatTime } from "../opportunities/OpportunityCard.js";
import type { ConversationWork, WorkRun, WorkStep } from "../types.js";
import { RUN_STATUS_LABELS, STEP_STATUS_LABELS, TOOL_LABELS } from "./labels.js";

interface WorkDetailPageProps {
  conversationId: string;
  onBack: () => void;
  onOpenConversation: (id: string) => void;
  onOpenLink: (url: string) => void;
}

/** One conversation as work: what was asked, what was done, and what came of it. */
export function WorkDetailPage({ conversationId, onBack, onOpenConversation, onOpenLink }: WorkDetailPageProps) {
  const { t } = useI18n();
  const [work, setWork] = useState<ConversationWork | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setWork(null); setError(null);
    void employeeApi.getConversationWork(conversationId)
      .then((next) => { if (live) setWork(next); })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "读取失败"); });
    return () => { live = false; };
  }, [conversationId]);

  return <div className="de-page de-work-log de-work-detail">
    <header className="de-employee-page-head">
      <nav aria-label={t("工作记录")}>
        <button type="button" className="de-text-button" onClick={onBack}>{t("返回")}</button>
        <button type="button" className="de-text-button" onClick={() => onOpenConversation(conversationId)}>{t("回到对话")}</button>
      </nav>
      <h1>{work?.title || t("工作记录")}</h1>
    </header>
    {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span></div>}
    {!work && !error && <div className="de-state">{t("加载中…")}</div>}
    {work?.runs.length === 0 && <div className="de-state de-empty-state"><strong>{t("这个对话还没有工作步骤")}</strong></div>}
    {work?.runs.map((run) => <RunCard key={run.id} run={run} onOpenLink={onOpenLink} />)}
  </div>;
}

function RunCard({ run, onOpenLink }: { run: WorkRun; onOpenLink: (url: string) => void }) {
  const { t, locale } = useI18n();
  return <article className={`de-work-run de-work-run-${run.status}`}>
    <header>
      <strong>{run.goal}</strong>
      <small>{t(RUN_STATUS_LABELS[run.status] ?? "结果未知")} · {formatTime(run.startedAt, locale)}</small>
    </header>
    {run.steps.length > 0 && <ol>
      {run.steps.map((step) => <StepRow key={step.id} step={step} onOpenLink={onOpenLink} />)}
    </ol>}
    {run.outcome && <div className="de-work-outcome markdown-body"><Markdown remarkPlugins={[remarkGfm]}>{run.outcome}</Markdown></div>}
  </article>;
}

function StepRow({ step, onOpenLink }: { step: WorkStep; onOpenLink: (url: string) => void }) {
  const { t } = useI18n();
  const { artifact } = step;
  return <li className={`de-work-step-${step.status}`}>
    <span>{t(TOOL_LABELS[step.tool] ?? "处理工作")}</span>
    {step.status !== "succeeded" && <small>{t(STEP_STATUS_LABELS[step.status] ?? "结果未知")}</small>}
    {artifact?.url
      ? <WorkLink url={artifact.url} label={artifact.label ? t(artifact.label) : t("查看")} onOpenLink={onOpenLink} />
      : artifact?.label && <em>{artifact.label}</em>}
  </li>;
}

/** The studio lives outside this workspace, so that one link is an ordinary page load. */
function WorkLink({ url, label, onOpenLink }: { url: string; label: string; onOpenLink: (url: string) => void }) {
  if (url.startsWith("/assistant")) return <a href={url}>{label}</a>;
  return <button type="button" className="de-text-button" onClick={() => onOpenLink(url)}>{label}</button>;
}
