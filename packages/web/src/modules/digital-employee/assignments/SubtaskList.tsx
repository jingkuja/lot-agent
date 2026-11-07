import { useState } from "react";
import { RunRecoveryCard } from "../../../components/RunRecoveryCard.js";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import type { AssignmentDetail, AssignmentSubtask, WorkRun } from "../types.js";
import { STEP_STATUS_LABELS, TOOL_LABELS } from "../work-log/labels.js";
import { FAILURE_LABELS, statusLabel, statusTone } from "./copy.js";
import { isOpenStatus } from "./grouping.js";

type Steps = Array<Pick<WorkRun, "id" | "steps">>;

interface SubtaskCardProps {
  taskId: string;
  item: AssignmentSubtask;
  busy: boolean;
  onChange: (work: () => Promise<unknown>) => void;
}

function SubtaskCard({ taskId, item, busy, onChange }: SubtaskCardProps) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<Steps | null>(null);
  const [opening, setOpening] = useState(false);
  const toggle = async () => {
    if (runs) return setRuns(null);
    setOpening(true);
    try { setRuns((await employeeApi.getSubtaskSteps(taskId, item.id)).runs); }
    finally { setOpening(false); }
  };
  const open = isOpenStatus(item.status);
  const steps = runs?.flatMap((run) => run.steps) ?? [];
  const note = item.failureReason ? t(FAILURE_LABELS[item.failureReason]) : item.result?.summary ?? item.summary ?? item.goal;
  const failed = item.status === "failed";
  return <article className="de-subtask-card">
    <header>
      <strong>{t("子任务 {0}：{1}", [item.position, item.title])}</strong>
      <em className={`de-assignment-status is-${statusTone({ status: item.status, pausedReason: null })}`}>{t(statusLabel({ status: item.status, pausedReason: null }))}</em>
    </header>
    <p>{note}</p>
    {failed && item.unverified > 0 && <RunRecoveryCard conversationId={item.conversationId} />}
    <footer>
      <button type="button" className="de-text-button" disabled={opening} aria-expanded={Boolean(runs)} onClick={() => void toggle()}>
        {t(runs ? "收起步骤" : "执行步骤")}
      </button>
      {failed && <button
        type="button" className="de-secondary-button" disabled={busy || item.unverified > 0}
        onClick={() => onChange(() => employeeApi.retrySubtask(taskId, item.id))}
      >{t("重试")}</button>}
      {open && <button type="button" className="de-secondary-button" disabled={busy} onClick={() => onChange(() => employeeApi.cancelSubtask(taskId, item.id))}>{t("取消")}</button>}
    </footer>
    {runs && (steps.length
      ? <ol className="de-subtask-steps">{steps.map((step) => <li key={step.id} className={`de-work-step-${step.status}`}>
        <span>{t(TOOL_LABELS[step.tool] ?? "处理工作")}</span>
        {step.status !== "succeeded" && <small>{t(STEP_STATUS_LABELS[step.status] ?? "")}</small>}
      </li>)}</ol>
      : <p className="de-assignment-hint">{t("还没有步骤。")}</p>)}
  </article>;
}

/** Open subtasks stay in view. Finished ones fold away, because a task can have many. */
export function SubtaskList({ item, busy, onChange }: { item: AssignmentDetail; busy: boolean; onChange: (work: () => Promise<unknown>) => void }) {
  const { t } = useI18n();
  const [goal, setGoal] = useState("");
  const taskOpen = isOpenStatus(item.status);
  if (!item.subtaskList.length && !taskOpen) return null;
  const open = item.subtaskList.filter((entry) => isOpenStatus(entry.status) || entry.status === "failed");
  const closed = item.subtaskList.filter((entry) => !open.includes(entry));
  const card = (entry: AssignmentSubtask) => <SubtaskCard key={entry.id} taskId={item.id} item={entry} busy={busy} onChange={onChange} />;
  return <section className="de-assignment-panel de-subtasks">
    <h2>{t("子任务")}{item.subtaskList.length > 0 && <small>{item.subtasks.done}/{item.subtasks.total}</small>}</h2>
    {open.map(card)}
    {closed.length > 0 && <details>
      <summary>{t("已结束 {0} 个", [closed.length])}</summary>
      {closed.map(card)}
    </details>}
    {taskOpen && <form onSubmit={(event) => {
      event.preventDefault();
      const text = goal.trim();
      if (!text) return;
      onChange(async () => { await employeeApi.addSubtask(item.id, text); setGoal(""); });
    }}>
      <input aria-label={t("加一个子任务")} placeholder={t("加一个子任务，写清楚要做什么")} maxLength={8000} value={goal} onChange={(event) => setGoal(event.target.value)} />
      <button className="de-secondary-button" disabled={busy || !goal.trim()}>{t("添加")}</button>
    </form>}
  </section>;
}
