import { useI18n } from "../../../i18n/index.js";
import { formatPoints } from "../../../lib/points.js";
import type { Assignment } from "../types.js";
import { TOOL_LABELS } from "../work-log/labels.js";
import { FAILURE_LABELS, MODE_LABELS, PAUSE_LABELS, statusLabel, statusTone } from "./copy.js";
import { isOpen } from "./grouping.js";

interface AssignmentCardProps {
  item: Assignment;
  /** A task carried up from an earlier day says when it began. */
  showDate: boolean;
  busy: boolean;
  onOpen: () => void;
  onAction: (action: "resume" | "retry" | "cancel") => void;
}

function oneLine(item: Assignment, t: (text: string, args?: unknown[]) => string): string {
  if (item.pausedReason) return t(PAUSE_LABELS[item.pausedReason]);
  if (item.result?.summary) return item.result.summary;
  if (item.failureReason) return t(FAILURE_LABELS[item.failureReason]);
  if (item.currentTool) return t("正在：{0}", [t(TOOL_LABELS[item.currentTool] ?? "处理工作")]);
  return item.goal;
}

export function AssignmentCard({ item, showDate, busy, onOpen, onAction }: AssignmentCardProps) {
  const { t, locale } = useI18n();
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", ...(showDate ? { month: "numeric", day: "numeric" } : {}) }).format(new Date(item.createdAt));
  const paused = item.pausedReason !== null;
  return <article className="de-assignment-card">
    <button type="button" className="de-assignment-card-main" onClick={onOpen}>
      <span className="de-assignment-card-head">
        <strong>{item.title}</strong>
        <em className={`de-assignment-status is-${statusTone(item)}`}>{t(statusLabel(item))}</em>
      </span>
      <span className="de-assignment-line">{oneLine(item, t)}</span>
      <small>
        <span>{time}</span>
        <span>{t(MODE_LABELS[item.mode])}</span>
        {item.subtasks.total > 0 && <span>{t("子任务 {0}/{1}", [item.subtasks.done, item.subtasks.total])}</span>}
        <span>{t("约 {0} 积分", [formatPoints(item.creditsUsed)])}</span>
        <span>{item.modelId}</span>
      </small>
    </button>
    {(paused || item.status === "failed" || isOpen(item)) && <footer>
      {paused && item.pausedReason === "quota" && <button type="button" className="de-primary-button" disabled={busy} onClick={() => onAction("resume")}>{t("继续")}</button>}
      {paused && item.pausedReason === "cost_limit" && <button type="button" className="de-primary-button" onClick={onOpen}>{t("调高上限")}</button>}
      {item.waitingDecisions > 0 && <button type="button" className="de-primary-button" onClick={onOpen}>{t("回答")}</button>}
      {item.status === "failed" && item.failureReason !== "unknown_outcome" && <button
        type="button" className="de-primary-button" disabled={busy} onClick={() => onAction("retry")}
      >{t("重试")}</button>}
      {item.status === "failed" && item.failureReason === "unknown_outcome" && <button type="button" className="de-primary-button" onClick={onOpen}>{t("去核实")}</button>}
      {isOpen(item) && <button type="button" className="de-secondary-button" disabled={busy} onClick={() => onAction("cancel")}>{t("取消")}</button>}
    </footer>}
  </article>;
}
