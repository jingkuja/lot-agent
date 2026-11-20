import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../../api/client.js";
import { FeishuSettings } from "../../components/FeishuSettings.js";
import { useI18n } from "../../i18n/index.js";
import { shouldAutoLoadMore } from "../../lib/auto-page.js";
import { useEmployeeLabels } from "./employee-labels.js";
import type { EmployeeView } from "./routes.js";
import { runningLabel } from "./today/copy.js";
import type { RunningWork } from "./types.js";

const PRIMARY_ENTRIES: Array<{ view: EmployeeView; label: string }> = [
  { view: "today", label: "今天" },
  { view: "customers", label: "客户" },
  { view: "materials", label: "产品资料" },
  { view: "marketing", label: "获客宝" },
];

const LOAD_MORE_THRESHOLD = 80;

interface EmployeeSidebarProps {
  active: boolean;
  name: string;
  running: RunningWork[];
  waiting: number;
  view: EmployeeView;
  /** The deployment has task dispatch on. */
  assignments: boolean;
  waitingTasks: number;
  isStreaming: boolean;
  conversations: Conversation[];
  activeConversationId: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNavigate: (view: EmployeeView) => void;
  onStreamEnd: () => void;
}

/** The employee card, workspace navigation, and conversation history. */
export function EmployeeSidebar({
  active,
  name,
  running,
  waiting,
  view,
  assignments,
  waitingTasks,
  isStreaming,
  conversations,
  activeConversationId,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpenConversation,
  onDeleteConversation,
  onNavigate,
  onStreamEnd,
}: EmployeeSidebarProps) {
  const { t } = useI18n();
  const labels = useEmployeeLabels(name);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const wasStreaming = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (wasStreaming.current && !isStreaming) onStreamEnd();
    wasStreaming.current = isStreaming;
  }, [isStreaming, onStreamEnd]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!hasMore || loadingMore) return;
      const el = event.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= LOAD_MORE_THRESHOLD) {
        onLoadMore();
      }
    },
    [hasMore, loadingMore, onLoadMore],
  );

  useEffect(() => {
    if (!active) return;
    const el = listRef.current;
    if (!el || el.clientHeight === 0) return;
    if (shouldAutoLoadMore({ hasMore, loadingMore, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })) {
      onLoadMore();
    }
  }, [active, conversations, hasMore, loadingMore, onLoadMore]);

  const status = running[0]
    ? t("工作中：{0}", [t(runningLabel(running[0].type))])
    : isStreaming ? t("工作中") : t("待命中");

  return (
    <>
      <div className="de-employee-sidebar">
        <div className={`de-employee-card ${view === "schedule" ? "active" : ""}`}>
          <button
            type="button"
            className="de-employee-card-main"
            aria-current={view === "schedule" ? "page" : undefined}
            title={labels.schedule}
            onClick={() => onNavigate("schedule")}
          >
            <span className="de-employee-avatar" aria-hidden>{[...name][0]}</span>
            <span className="de-employee-card-copy">
              <strong>{name}</strong>
              <small>{status}</small>
            </span>
          </button>
          <button
            type="button"
            className="agent-feishu-toggle"
            aria-label={t("飞书接入")}
            title={t("飞书接入")}
            onClick={() => setFeishuOpen(true)}
          >
            <span className="agent-feishu-icon" aria-hidden>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="m21 3-7 18-4-7-7-4 18-7Z" strokeLinejoin="round" />
                <path d="m10 14 6-6" />
              </svg>
            </span>
            <span>{t("飞书")}</span>
          </button>
        </div>

        <nav className="de-employee-nav" aria-label={t("数字员工")}>
          {PRIMARY_ENTRIES.map((entry) => (
            <button
              key={entry.view}
              type="button"
              className={view === entry.view ? "active" : ""}
              aria-current={view === entry.view ? "page" : undefined}
              onClick={() => onNavigate(entry.view)}
            >
              <span>{t(entry.label)}</span>
              {entry.view === "today" && waiting > 0 && <b>{waiting}</b>}
            </button>
          ))}
          <hr />
          {assignments && (
            <button
              type="button"
              className={view === "assignments" ? "active" : ""}
              aria-current={view === "assignments" ? "page" : undefined}
              onClick={() => onNavigate("assignments")}
            >
              <span>{labels.assignments}</span>
              {waitingTasks > 0 && <b>{waitingTasks}</b>}
            </button>
          )}
          <button
            type="button"
            className={view === "work-log" ? "active" : ""}
            aria-current={view === "work-log" ? "page" : undefined}
            onClick={() => onNavigate("work-log")}
          >
            <span>{t("工作记录")}</span>
          </button>
        </nav>

        <section className="de-sidebar-conversations" aria-label={t("对话记录")}>
          <div className="de-sidebar-conversations-head">{t("对话记录")}</div>
          <div className="de-sidebar-conversations-list" ref={listRef} onScroll={handleScroll}>
            {conversations.length === 0 && !loadingMore && (
              <div className="de-sidebar-conversations-empty">{t("还没有对话记录")}</div>
            )}
            {conversations.map((conversation) => {
              const isActive = view === "chat" && conversation.id === activeConversationId;
              const title = conversation.title || t("新对话");
              return (
                <div key={conversation.id} className={`de-sidebar-conversation ${isActive ? "active" : ""}`}>
                  <button
                    type="button"
                    className="de-sidebar-conversation-link"
                    aria-current={isActive ? "page" : undefined}
                    title={title}
                    onClick={() => onOpenConversation(conversation.id)}
                  >
                    {title}
                  </button>
                  <button
                    type="button"
                    className="de-sidebar-conversation-delete"
                    aria-label={t("删除对话")}
                    onClick={() => onDeleteConversation(conversation.id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {loadingMore && <div className="sidebar-loading-more">{t("加载中…")}</div>}
          </div>
        </section>
      </div>
      {feishuOpen && createPortal(<FeishuSettings onClose={() => setFeishuOpen(false)} />, document.body)}
    </>
  );
}
