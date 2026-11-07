import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n/index.js";
import { useEmployeeLabels } from "./employee-labels.js";
import type { EmployeeView } from "./routes.js";
import { runningLabel } from "./today/copy.js";
import type { RunningWork } from "./types.js";

const ENTRIES: Array<{ view: EmployeeView; label: string }> = [
  { view: "today", label: "今天" },
  { view: "customers", label: "客户" },
  { view: "materials", label: "资料" },
  { view: "work-log", label: "工作记录" },
];

interface EmployeeSidebarProps {
  name: string;
  running: RunningWork[];
  waiting: number;
  view: EmployeeView;
  /** The deployment has task dispatch on. */
  assignments: boolean;
  waitingTasks: number;
  isStreaming: boolean;
  onNavigate: (view: EmployeeView) => void;
  onNewConversation: () => void;
  onStreamEnd: () => void;
}

/** The employee card and the only navigation of the workspace. */
export function EmployeeSidebar({
  name, running, waiting, view, assignments, waitingTasks, isStreaming, onNavigate, onNewConversation, onStreamEnd,
}: EmployeeSidebarProps) {
  const { t } = useI18n();
  const labels = useEmployeeLabels(name);
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) onStreamEnd();
    wasStreaming.current = isStreaming;
  }, [isStreaming, onStreamEnd]);
  const status = running[0]
    ? t("工作中：{0}", [t(runningLabel(running[0].type))])
    : isStreaming ? t("工作中") : t("待命中");
  return <div className="de-employee-sidebar">
    <button type="button" className="de-employee-card" onClick={() => onNavigate("schedule")} title={labels.schedule}>
      <span className="de-employee-avatar" aria-hidden>{[...name][0]}</span>
      <span><strong>{name}</strong><small>{status}</small></span>
    </button>
    <nav className="de-employee-nav" aria-label={t("数字员工")}>
      {ENTRIES.map((entry) => <button
        key={entry.view}
        type="button"
        className={view === entry.view ? "active" : ""}
        aria-current={view === entry.view ? "page" : undefined}
        onClick={() => onNavigate(entry.view)}
      >
        {t(entry.label)}
        {entry.view === "today" && waiting > 0 && <b>{waiting}</b>}
      </button>)}
      <hr />
      <button
        type="button"
        className={view === "schedule" ? "active" : ""}
        aria-current={view === "schedule" ? "page" : undefined}
        onClick={() => onNavigate("schedule")}
      ><span>{labels.schedule}</span></button>
      {assignments && <button
        type="button"
        className={view === "assignments" ? "active" : ""}
        aria-current={view === "assignments" ? "page" : undefined}
        onClick={() => onNavigate("assignments")}
      >
        <span>{labels.assignments}</span>
        {waitingTasks > 0 && <b>{waitingTasks}</b>}
      </button>}
      <button
        type="button"
        className={view === "marketing" ? "active" : ""}
        aria-current={view === "marketing" ? "page" : undefined}
        onClick={() => onNavigate("marketing")}
      >{t("获客宝")}</button>
    </nav>
    <button type="button" className="de-new-chat-button" onClick={onNewConversation}>
      <span aria-hidden>＋</span>{t("新对话")}
    </button>
  </div>;
}
