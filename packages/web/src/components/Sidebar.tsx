import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ConversationProject, type Agent, type Conversation } from "../api/client.js";
import { SidebarAgentTabs } from "./SidebarAgentTabs.js";
import { shouldAutoLoadMore } from "../lib/auto-page.js";

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
  onCreateInProject: (id: string) => void;
  onMove: (id: string, projectId: string | null) => Promise<void>;
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
  onCreateInProject,
  onMove,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: SidebarProps) {
  const [projects, setProjects] = useState<ConversationProject[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api.listProjects().then(setProjects).catch(() => setError("项目加载失败，请刷新重试")); }, []);
  useEffect(() => {
    const projectId = conversations.find((conv) => conv.id === activeId)?.project_id;
    if (projectId) setCollapsed((prev) => { const next = new Set(prev); next.delete(projectId); return next; });
  }, [activeId, conversations]);
  const renderConversation = (conv: Conversation) => (
    <div key={conv.id} className={`sidebar-item ${conv.id === activeId ? "active" : ""}`}>
      <button className="sidebar-conversation-link sidebar-item-title" onClick={() => onSelect(conv.id)} title={conv.title}>{conv.title}</button>
      {conv.id !== "__new__" && <>
        <select className="sidebar-project-move" aria-label={`移动“${conv.title}”到项目`} title="移入项目" value={conv.project_id ?? ""}
          onChange={(e) => { setError(""); void onMove(conv.id, e.target.value || null).catch(() => setError("移动失败，请重试")); }}>
          <option value="">最近（无项目）</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <button className="btn-delete" aria-label="删除对话" onClick={() => onDelete(conv.id)}>×</button>
      </>}
    </div>
  );
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

  // When the list is filtered per agent, the visible rows can be too few to
  // overflow the container — leaving no scrollbar and thus no way for
  // handleScroll to fire loadMore, which strands rows on later pages. After each
  // render, if more pages exist and the current content isn't scrollable, fetch
  // the next page. This repeats (deps below re-run it once loadingMore settles or
  // the filtered list changes) until content overflows or pages run out.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !onLoadMore) return;
    if (
      shouldAutoLoadMore({
        hasMore,
        loadingMore,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      })
    ) {
      onLoadMore();
    }
  }, [conversations, hasMore, loadingMore, onLoadMore]);

  return (
    <aside className="sidebar">
      <SidebarAgentTabs
        agents={installedAgents}
        activeId={activeAgentId}
        onSwitch={onSwitchAgent}
        disabled={switchDisabled}
      />
      <div className="sidebar-recent-header">
        <button className="btn-new sidebar-create-project" onClick={() => { setCreating(true); setError(""); }} title="创建项目">创建项目</button>
        <button className="btn-new" onClick={onCreate} title="新建对话">
          <svg className="btn-new-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 8.5v7M8.5 12h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          新对话
        </button>
      </div>
      {creating && <form className="sidebar-project-form" onSubmit={async (e) => {
        e.preventDefault(); if (!name.trim() || busy) return;
        setBusy(true); setError("");
        try { const project = await api.createProject(name.trim()); setProjects((prev) => [project, ...prev]); setName(""); setCreating(false); }
        catch { setError("创建失败，请重试"); } finally { setBusy(false); }
      }}>
        <input autoFocus aria-label="项目名称" placeholder="项目名称" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setCreating(false); }} />
        <button type="submit" disabled={busy || !name.trim()}>{busy ? "创建中…" : "创建"}</button>
        <button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button>
      </form>}
      {error && <div className="sidebar-project-error" role="alert">{error}</div>}
      <div className="sidebar-list" ref={listRef} onScroll={handleScroll}>
        {projects.length > 0 && <div className="sidebar-section-label project-section-label">项目</div>}
        {projects.map((project) => {
          const items = conversations.filter((conv) => conv.project_id === project.id);
          const expanded = !collapsed.has(project.id);
          return <section key={project.id} className="sidebar-project">
            <div className="sidebar-project-header">
              <button className="sidebar-project-toggle" aria-expanded={expanded} onClick={() => setCollapsed((prev) => {
                const next = new Set(prev); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next;
              })}>
                <span aria-hidden>{expanded ? "⌄" : "›"}</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
                <span>{project.name}</span>
              </button>
              <button className="sidebar-project-add" aria-label={`在${project.name}中新建对话`} title="项目内新建对话" onClick={() => onCreateInProject(project.id)}>+</button>
            </div>
            {expanded && <div className="sidebar-project-conversations">
              {items.map(renderConversation)}
              {items.length === 0 && <button className="sidebar-project-empty" onClick={() => onCreateInProject(project.id)}>开始新对话</button>}
            </div>}
          </section>;
        })}
        <div className="sidebar-section-label project-section-label">最近</div>
        {conversations.filter((conv) => !conv.project_id).map(renderConversation)}
        {loadingMore && <div className="sidebar-loading-more">加载中…</div>}
      </div>
    </aside>
  );
}
