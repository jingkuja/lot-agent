import { useCallback, useMemo } from "react";
import type { Agent, Conversation } from "../api/client.js";

interface SidebarProps {
  conversations: Conversation[];
  agents: Agent[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}

/** Trigger loadMore when the scroll position is within this many px of bottom. */
const LOAD_MORE_THRESHOLD = 80;

/** Short label + CSS modifier per agent type, for the per-conversation tag. */
const TAG_BY_TYPE: Record<string, { label: string; mod: string }> = {
  general: { label: "通用", mod: "general" },
  copywriting: { label: "文案", mod: "copy" },
  image: { label: "图片", mod: "image" },
  video: { label: "视频", mod: "video" },
};

export function Sidebar({
  conversations,
  agents,
  activeId,
  onSelect,
  onDelete,
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
  // Map an agent_id to its tag (label + color modifier). Falls back to the
  // agent's own name when the type is unknown, then to a neutral "通用".
  const tagFor = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]));
    return (agentId: string) => {
      const agent = byId.get(agentId);
      const byType = agent && TAG_BY_TYPE[agent.type];
      if (byType) return byType;
      if (agent) return { label: agent.name.slice(0, 2), mod: "general" };
      return TAG_BY_TYPE.general;
    };
  }, [agents]);

  return (
    <aside className="sidebar">
      {conversations.length > 0 && <div className="sidebar-section-label">最近对话</div>}
      <div className="sidebar-list" onScroll={handleScroll}>
        {conversations.map((conv) => {
          const tag = tagFor(conv.agent_id);
          return (
            <div
              key={conv.id}
              className={`sidebar-item ${conv.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(conv.id)}
            >
              <span className="sidebar-item-title">{conv.title}</span>
              <span className={`agent-tag agent-tag--${tag.mod}`}>{tag.label}</span>
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
          );
        })}
        {loadingMore && <div className="sidebar-loading-more">加载中…</div>}
      </div>
    </aside>
  );
}
