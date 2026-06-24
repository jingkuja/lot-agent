import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { Sidebar } from "../components/Sidebar.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { BrandHeader } from "../components/BrandHeader.js";
import { PreviewPanel } from "../components/PreviewPanel.js";
import { ArtifactGallery, type Artifact } from "../components/ArtifactGallery.js";
import { AgentSwitcher } from "../components/AgentSwitcher.js";
import { useConversations } from "../hooks/useConversations.js";
import { useChat } from "../hooks/useChat.js";
import { api, type Agent, type User } from "../api/client.js";

interface WorkspaceProps {
  agents: Agent[];
  user: User;
  onLogout: () => void;
}

export function Workspace({ agents, user, onLogout }: WorkspaceProps) {
  const orderedAgents = useMemo(() => {
    const general = agents.find((a) => a.type === "general" || a.id === "general");
    if (!general) return agents;
    return [general, ...agents.filter((a) => a !== general)];
  }, [agents]);

  const defaultAgentId = orderedAgents[0]?.id ?? "general";
  const [activeAgentId, setActiveAgentId] = useState(defaultAgentId);
  const activeAgent = orderedAgents.find((a) => a.id === activeAgentId) ?? null;

  // newAgentId: page-only "new chat" state. No server conversation exists yet.
  // null = viewing a real conversation; string = pending new chat for that agent.
  const [newAgentId, setNewAgentId] = useState<string | null>(null);

  const { conversations, activeId, setActiveId, remove, loading, refresh } =
    useConversations();
  const [artifacts] = useState<Artifact[]>([]);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleStreamEnd = useCallback(() => {
    // The server finalizes the auto-generated title before emitting stream_end,
    // so refresh right away to pull in the summarized conversation title.
    refresh();
  }, [refresh]);

  const activeIdRef = useRef(activeId);
  const { messages, send, stop, isStreaming, loadMessages, clear, regenerate } =
    useChat(activeId, handleStreamEnd, activeIdRef);

  const prevActiveId = useRef<string | null>(null);
  useEffect(() => {
    if (activeId !== prevActiveId.current) {
      prevActiveId.current = activeId;
      setPreviewContent(null);
    }
  }, [activeId]);

  // Keep useChat's conversationId ref in sync.
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // On mount: open the most recent conversation, or enter new-chat mode.
  const didInit = useRef(false);
  useEffect(() => {
    if (loading || didInit.current) return;
    didInit.current = true;
    if (conversations.length > 0) {
      const latest = conversations[0];
      setActiveAgentId(latest.agent_id || defaultAgentId);
      setActiveId(latest.id);
      clear();
      loadMessages(latest.id);
    } else {
      setNewAgentId(defaultAgentId);
    }
  }, [loading, conversations, defaultAgentId, setActiveId, clear, loadMessages]);

  const handleSwitchAgent = useCallback(
    (agentId: string) => {
      if (agentId === activeAgentId && !newAgentId && messages.length === 0) return;
      if (newAgentId) {
        // Already in new-chat mode — just switch the agent.
        setNewAgentId(agentId);
        setActiveAgentId(agentId);
        return;
      }
      // Enter new-chat mode for the new agent.
      setNewAgentId(agentId);
      setActiveAgentId(agentId);
      setActiveId(null);
      clear();
      setPreviewContent(null);
    },
    [activeAgentId, newAgentId, messages.length, setActiveId, clear]
  );

  const handleSelect = useCallback(
    (id: string) => {
      if (id === "__new__") return; // already in new-chat mode
      // A conversation is bound to one agent — sync the switcher to it.
      const conv = conversations.find((c) => c.id === id);
      if (conv) setActiveAgentId(conv.agent_id || defaultAgentId);
      setNewAgentId(null);
      setActiveId(id);
      clear();
      loadMessages(id);
      setPreviewContent(null);
    },
    [conversations, defaultAgentId, setActiveId, loadMessages, clear]
  );

  const handleCreate = useCallback(() => {
    if (newAgentId) return; // already in new-chat mode
    setNewAgentId(activeAgentId);
    setActiveId(null);
    clear();
    setPreviewContent(null);
  }, [newAgentId, activeAgentId, setActiveId, clear]);

  // Send wrapper: creates the server conversation on first message if needed.
  const doSend = useCallback(
    async (content: string) => {
      if (newAgentId) {
        const conv = await api.createConversation(undefined, newAgentId);
        activeIdRef.current = conv.id; // sync ref before send reads it
        setActiveId(conv.id);
        setNewAgentId(null);
        refresh();
        send(content);
        return;
      }
      send(content);
    },
    [newAgentId, setActiveId, refresh, send]
  );

  const handleDelete = useCallback(
    (id: string) => {
      remove(id);
      if (id === activeId) {
        // Deleting the open conversation drops us into new-chat mode (rather
        // than a dead empty state), so the input can create + send a new
        // conversation instead of silently doing nothing.
        clear();
        setPreviewContent(null);
        setNewAgentId(activeAgentId);
      }
    },
    [remove, activeId, clear, activeAgentId]
  );

  // Sidebar list: prepend a virtual "新对话" entry when in new-chat mode.
  const sidebarConversations = useMemo(() => {
    if (!newAgentId) return conversations;
    return [
      { id: "__new__", title: "新对话", agent_id: newAgentId, created_at: "", updated_at: "" },
      ...conversations,
    ];
  }, [newAgentId, conversations]);

  const switcher = (
    <AgentSwitcher
      agents={orderedAgents}
      activeId={activeAgentId}
      onSwitch={handleSwitchAgent}
      disabled={isStreaming}
    />
  );

  return (
    <div className="workspace">
      <div className={`workspace-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <BrandHeader
          user={user}
          onLogout={onLogout}
          onCreate={handleCreate}
          onCollapse={() => setSidebarCollapsed(true)}
        />
        <Sidebar
          conversations={sidebarConversations}
          agents={orderedAgents}
          activeId={newAgentId ? "__new__" : activeId}
          onSelect={handleSelect}
          onDelete={handleDelete}
        />
      </div>

      <div className="workspace-main">
        {sidebarCollapsed && (
          <button
            className="sidebar-expand"
            onClick={() => setSidebarCollapsed(false)}
            title="展开侧栏"
            aria-label="展开侧栏"
          >
            ›
          </button>
        )}
        <div className="workspace-chat">
          <ChatPanel
            messages={messages}
            onSend={doSend}
            onStop={stop}
            isStreaming={isStreaming}
            activeConversationId={activeId}
            onRegenerate={regenerate}
            inputLeftSlot={switcher}
            onSelectForPreview={setPreviewContent}
            agent={activeAgent}
          />
        </div>

        {previewContent !== null && (
          <div className="workspace-right">
            <PreviewPanel
              content={previewContent}
              onClose={() => setPreviewContent(null)}
            />
            <ArtifactGallery artifacts={artifacts} />
          </div>
        )}
      </div>
    </div>
  );
}
