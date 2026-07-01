import { useCallback } from "react";
import type { Agent, Conversation } from "../api/client.js";
import { SidebarAgentTabs } from "./SidebarAgentTabs.js";

interface SidebarProps {
  conversations: Conversation[];
  installedAgents: Agent[];
  activeAgentId: string;
  onSwitchAgent: (agentId: string) => void;
  switchDisabled?: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}

/** Trigger loadMore when the scroll position is within this many px of bottom. */
const LOAD_MORE_THRESHOLD = 80;

export function Sidebar({
  conversations,
  installedAgents,
  activeAgentId,
  onSwitchAgent,
  switchDisabled,
  activeId,
  onSelect,
  onDelete,
  onCreate,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: SidebarProps) {
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!onLoadMore || !hasMore || loadingMore) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= LOAD_MORE_THRESHOLD) {
        onLoadMore();
      }
    },
    [onLoadMore, hasMore, loadingMore]
  );

  return (
    <aside className="sidebar">
      <SidebarAgentTabs
        agents={installedAgents}
        activeId={activeAgentId}
        onSwitch={onSwitchAgent}
        disabled={switchDisabled}
      />
      <div className="sidebar-recent-header">
        {conversations.length > 0 && <span className="sidebar-section-label">历史对话</span>}
        <button className="btn-new" onClick={onCreate} title="新建对话">
          <svg className="btn-new-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 8.5v7M8.5 12h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          新对话
        </button>
      </div>
      <div className="sidebar-list" onScroll={handleScroll}>
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`sidebar-item ${conv.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(conv.id)}
          >
            <span className="sidebar-item-title">{conv.title}</span>
            <button
              className="btn-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(conv.id);
              }}
            >
              x
            </button>
          </div>
        ))}
        {loadingMore && <div className="sidebar-loading-more">加载中…</div>}
      </div>
    </aside>
  );
}
