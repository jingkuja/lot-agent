import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileLink } from "../../../components/FileLink.js";
import { RechargeModal } from "../../../components/RechargeModal.js";
import { RunRecoveryCard } from "../../../components/RunRecoveryCard.js";
import { useI18n } from "../../../i18n/index.js";
import { formatPoints } from "../../../lib/points.js";
import { employeeApi } from "../api.js";
import type { AssignmentDetail, WorkStep } from "../types.js";
import { RUN_STATUS_LABELS, STEP_STATUS_LABELS, TOOL_LABELS } from "../work-log/labels.js";
import { FAILURE_LABELS, MODE_LABELS, PAUSE_LABELS, statusLabel, statusTone } from "./copy.js";
import { DecisionCard } from "./DecisionCard.js";
import { isOpen } from "./grouping.js";

const POLL_MS = 3_000;

interface DetailProps {
  id: string;
  onBack: () => void;
  onOpenLink: (url: string) => void;
}

function Artifact({ step, onOpenLink }: { step: WorkStep; onOpenLink: (url: string) => void }) {
  const { t } = useI18n();
  const artifact = step.artifact;
  if (!artifact?.url) return null;
  if (artifact.download) {
    return <FileLink url={artifact.url} download={artifact.label ?? undefined} target="_blank" rel="noreferrer">{t("下载")}</FileLink>;
  }
  return <button type="button" className="de-text-button" onClick={() => onOpenLink(artifact.url!)}>
    {t(artifact.needsReview ? "有内容等你审阅" : "查看")}
  </button>;
}

/** The result first, then the decisions the employee took for the owner, then how it got there. */
export function AssignmentDetailPage({ id, onBack, onOpenLink }: DetailProps) {
  const { t, locale } = useI18n();
  const [item, setItem] = useState<AssignmentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState("");
  const [recharging, setRecharging] = useState(false);

  const load = useCallback(async () => {
    try {
      setItem(await employeeApi.getAssignment(id));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  const open = item ? isOpen(item) : false;
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, load]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(false); }
  };

  const newLimit = limit.trim() ? Number(limit) : null;
  const artifacts = item?.runs.flatMap((entry) => entry.steps).filter((step) => step.artifact?.url) ?? [];
  const steps = item ? [...item.runs].reverse() : [];

  return <div className="de-page de-assignment-detail">
    <header className="de-employee-page-head">
      <nav aria-label={t("任务分派")}><button type="button" className="de-text-button" onClick={onBack}>{t("返回")}</button></nav>
      <h1>{item?.title ?? t("任务分派")}</h1>
    </header>
    {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span></div>}
    {!item && !error && <div className="de-state">{t("加载中…")}</div>}
    {item && <>
      <section className="de-assignment-panel">
        <div className="de-assignment-summary-row">
          <em className={`de-assignment-status is-${statusTone(item)}`}>{t(statusLabel(item))}</em>
          <small>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.createdAt))}</small>
          <small>{t(MODE_LABELS[item.mode])}</small>
          <small>{item.modelId}</small>
          <small>{t("约 {0} 积分", [formatPoints(item.creditsUsed)])}</small>
          {item.creditLimit !== null && <small>{t("上限 {0} 积分", [formatPoints(item.creditLimit)])}</small>}
        </div>
        <p className="de-assignment-goal">{item.goal}</p>
        {item.attachments.length > 0 && <small>{t("附件：{0}", [item.attachments.join("、")])}</small>}
        {item.pausedReason && <p className="de-assignment-note" role="status">{t(PAUSE_LABELS[item.pausedReason])}</p>}
        {item.failureReason && item.status !== "waiting_user" && <p className="de-assignment-note is-error" role="status">{t(FAILURE_LABELS[item.failureReason])}</p>}
        {item.status === "failed" && item.unverified > 0 && <RunRecoveryCard conversationId={item.conversationId} />}
        <footer>
          {item.pausedReason === "quota" && <button
            type="button" className="de-primary-button" disabled={busy}
            onClick={() => void run(() => employeeApi.resumeAssignment(id))}
          >{t("继续")}</button>}
          {item.pausedReason === "quota" && <button type="button" className="de-secondary-button" onClick={() => setRecharging(true)}>{t("充值")}</button>}
          {item.status === "failed" && <button
            type="button" className="de-primary-button" disabled={busy || item.unverified > 0}
            onClick={() => void run(() => employeeApi.retryAssignment(id))}
          >{t("重试")}</button>}
          {open && <button type="button" className="de-secondary-button" disabled={busy} onClick={() => void run(() => employeeApi.cancelAssignment(id))}>{t("取消任务")}</button>}
        </footer>
        {open && <form
          className="de-assignment-limit"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              if (item.pausedReason === "cost_limit") await employeeApi.resumeAssignment(id, newLimit);
              else await employeeApi.setAssignmentLimit(id, newLimit);
              setLimit("");
            });
          }}
        >
          <label>
            <span>{t("费用上限（积分）")}</span>
            <input type="number" min="1" step="1" inputMode="numeric" placeholder={t("不设上限")} value={limit} onChange={(event) => setLimit(event.target.value)} />
          </label>
          <button className="de-secondary-button" disabled={busy}>{t(item.pausedReason === "cost_limit" ? "保存并继续" : "保存上限")}</button>
        </form>}
      </section>

      {item.decisions.length > 0 && <section className="de-assignment-panel de-assignment-decisions">
        <h2>{t("等你决定")}</h2>
        {item.decisions.map((decision) => <DecisionCard key={decision.id} decision={decision} onAnswered={load} />)}
      </section>}

      {item.result && <section className="de-assignment-panel">
        <h2>{t("结果")}</h2>
        <div className="de-assignment-result"><Markdown remarkPlugins={[remarkGfm]}>{item.result.summary}</Markdown></div>
        {item.result.assumptions.length > 0 && <>
          <h3>{t("员工替你做的决定")}</h3>
          <ul>{item.result.assumptions.map((note) => <li key={note}>{note}</li>)}</ul>
        </>}
        {item.result.skipped.length > 0 && <>
          <h3>{t("没有做的")}</h3>
          <ul>{item.result.skipped.map((note) => <li key={note}>{note}</li>)}</ul>
        </>}
      </section>}

      {artifacts.length > 0 && <section className="de-assignment-panel">
        <h2>{t("产物")}</h2>
        <ul className="de-assignment-artifacts">
          {artifacts.map((step) => <li key={step.id}>
            <span>{step.artifact?.label ?? t(TOOL_LABELS[step.tool] ?? "处理工作")}</span>
            <Artifact step={step} onOpenLink={onOpenLink} />
          </li>)}
        </ul>
      </section>}

      <section className="de-assignment-panel">
        <h2>{t("执行步骤")}</h2>
        {steps.every((entry) => !entry.steps.length) && <p className="de-assignment-hint">{t(open ? "还没有步骤，员工正在开始。" : "这个任务没有工具步骤。")}</p>}
        {steps.map((entry) => entry.steps.length > 0 && <article className={`de-work-run de-work-run-${entry.status}`} key={entry.id}>
          <header>
            <strong>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(entry.startedAt))}</strong>
            <small>{t(RUN_STATUS_LABELS[entry.status] ?? "没有完成")}</small>
          </header>
          <ol>{entry.steps.map((step) => <li key={step.id} className={`de-work-step-${step.status}`}>
            <span>{t(TOOL_LABELS[step.tool] ?? "处理工作")}</span>
            {step.status !== "succeeded" && <small>{t(STEP_STATUS_LABELS[step.status] ?? "")}</small>}
          </li>)}</ol>
        </article>)}
      </section>
    </>}
    {recharging && <RechargeModal onClose={() => setRecharging(false)} />}
  </div>;
}
