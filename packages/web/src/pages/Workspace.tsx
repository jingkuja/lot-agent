import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { Sidebar } from "../components/Sidebar.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { BrandHeader } from "../components/BrandHeader.js";
import { PreviewPanel } from "../components/PreviewPanel.js";
import { ArtifactGallery, type Artifact } from "../components/ArtifactGallery.js";
import { AgentSwitcher } from "../components/AgentSwitcher.js";
import { AgentCenterModal } from "../components/AgentCenterModal.js";
import { useConversations } from "../hooks/useConversations.js";
import { useChat } from "../hooks/useChat.js";
import { useAgents } from "../hooks/useAgents.js";
import { useModels } from "../hooks/useModels.js";
import { api, type User } from "../api/client.js";
import { GENERAL_ID } from "../lib/agent-order.js";

interface WorkspaceProps {
  user: User;
  onLogout: () => void;
}

export function Workspace({ user, onLogout }: WorkspaceProps) {
  const { agents, installed, install, uninstall, promote } = useAgents(true);

  // 已安装 agents;general 恒第一(仅用于 Sidebar 标签映射等需要全序的场景)。
  const orderedAgents = useMemo(() => {
    const general = installed.find((a) => a.type === "general" || a.id === GENERAL_ID);
    if (!general) return installed;
    return [general, ...installed.filter((a) => a !== general)];
  }, [installed]);

  const defaultAgentId = orderedAgents[0]?.id ?? GENERAL_ID;
  const [activeAgentId, setActiveAgentId] = useState(defaultAgentId);
  const activeAgent = agents.find((a) => a.id === activeAgentId) ?? null;

  // newAgentId: page-only "new chat" state. No server conversation exists yet.
  // null = viewing a real conversation; string = pending new chat for that agent.
  const [newAgentId, setNewAgentId] = useState<string | null>(null);

  const {
    conversations,
    activeId,
    setActiveId,
    remove,
    loadingMore,
    hasMore,
    loadMore,
    refresh,
    updateTitle,
    addLocal,
  } = useConversations();
  const [artifacts] = useState<Artifact[]>([]);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [centerOpen, setCenterOpen] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);

  const handleStreamEnd = useCallback(() => {
    // The server finalizes the auto-generated title before emitting stream_end,
    // so refresh right away to pull in the summarized conversation title.
    refresh();
  }, [refresh]);

  const activeIdRef = useRef(activeId);
  const { messages, conversationModel, send, stop, isStreaming, loadMessages, clear, regenerate, generateMedia } =
    useChat(activeId, handleStreamEnd, activeIdRef, updateTitle);

  // Per-user model catalog + the model selected for the current conversation.
  const { models: modelCatalog } = useModels();
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Seed the picker from the loaded conversation's stored model.
  useEffect(() => { setSelectedModel(conversationModel); }, [conversationModel]);

  const prevActiveId = useRef<string | null>(null);
  useEffect(() => {
    if (activeId !== prevActiveId.current) {
      prevActiveId.current = activeId;
      setPreviewContent(null);
    }
  }, [activeId]);

  // Keep useChat's conversationId ref in sync.
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // On mount: always land on a fresh new-chat window (greeting), regardless of
  // history. Past conversations stay in the sidebar and open when selected.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    setNewAgentId(defaultAgentId);
  }, [defaultAgentId]);

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

  const handlePickOverflow = useCallback(
    async (agentId: string) => {
      await promote(agentId);   // 移到子 Agent 首位(整体第二位),持久化
      handleSwitchAgent(agentId);
    },
    [promote, handleSwitchAgent]
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
    async (content: string, files: File[] = [], settings?: unknown) => {
      const kind = activeAgent?.type || activeAgent?.id;
      const dispatch = () => {
        if (kind === "image" || kind === "video") {
          generateMedia(content, kind as "image" | "video", settings, files, selectedModel ?? undefined);
        } else {
          send(content, files, undefined, selectedModel ?? undefined);
        }
      };
      if (newAgentId) {
        const conv = await api.createConversation(undefined, newAgentId);
        activeIdRef.current = conv.id;
        setActiveId(conv.id);
        setNewAgentId(null);
        // The server list omits 0-message conversations, so optimistically
        // surface this one in the sidebar instead of refreshing (which wouldn't
        // return it yet). stream_end triggers a real refresh once it has content.
        addLocal(conv);
        dispatch();
        return;
      }
      dispatch();
    },
    [newAgentId, setActiveId, addLocal, send, generateMedia, activeAgent, selectedModel]
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

  const handleInstall = useCallback(
    async (id: string) => {
      setBusyAgentId(id);
      try { await install(id); } finally { setBusyAgentId(null); }
    },
    [install]
  );

  const handleUninstall = useCallback(
    async (id: string) => {
      setBusyAgentId(id);
      try {
        await uninstall(id);
        // 卸载当前激活的 Agent → 回落通用并进入新会话态
        if (id === activeAgentId) {
          setActiveAgentId(GENERAL_ID);
          setNewAgentId(GENERAL_ID);
          setActiveId(null);
          clear();
          setPreviewContent(null);
        }
      } finally {
        setBusyAgentId(null);
      }
    },
    [uninstall, activeAgentId, setActiveId, clear]
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
      agents={installed}
      activeId={activeAgentId}
      onSwitch={handleSwitchAgent}
      onPickOverflow={handlePickOverflow}
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
          onOpenAgentCenter={() => setCenterOpen(true)}
        />
        <Sidebar
          conversations={sidebarConversations}
          agents={agents}
          activeId={newAgentId ? "__new__" : activeId}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onLoadMore={loadMore}
          hasMore={hasMore}
          loadingMore={loadingMore}
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
            inputAbove={switcher}
            // 预览仅对「文案制作」Agent 开放；通用 / 图片 / 视频不需要。
            onSelectForPreview={
              activeAgent?.type === "copywriting" || activeAgent?.id === "copywriting"
                ? setPreviewContent
                : undefined
            }
            agent={activeAgent}
            userName={user.name}
            modelCatalog={modelCatalog}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
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
      {centerOpen && (
        <AgentCenterModal
          agents={agents}
          onInstall={handleInstall}
          onUninstall={handleUninstall}
          onClose={() => setCenterOpen(false)}
          busyId={busyAgentId}
        />
      )}
    </div>
  );
}
