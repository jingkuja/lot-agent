import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { Sidebar } from "../components/Sidebar.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { BrandHeader } from "../components/BrandHeader.js";
import { PreviewPanel } from "../components/PreviewPanel.js";
import { ArtifactGallery, type Artifact } from "../components/ArtifactGallery.js";
import { AgentCenterModal } from "../components/AgentCenterModal.js";
import { KeySettingsModal } from "../components/KeySettingsModal.js";
import { AgentSwitcher } from "../components/AgentSwitcher.js";
import { useConversations } from "../hooks/useConversations.js";
import { useChat } from "../hooks/useChat.js";
import { useAgents } from "../hooks/useAgents.js";
import { useModels } from "../hooks/useModels.js";
import { api, type User, type PickedFile } from "../api/client.js";
import { GENERAL_ID } from "../lib/agent-order.js";
import { EMPTY_SELECTED, fillModelDefaults, groupForKind, resolveLlmSelection } from "../lib/model-defaults.js";

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

  // The agent of the chat currently on screen (drives the panel/input/model),
  // decoupled from activeAgentId which only highlights the tab + filters the list.
  const openAgentId =
    newAgentId ??
    conversations.find((c) => c.id === activeId)?.agent_id ??
    defaultAgentId;
  const openAgent = agents.find((a) => a.id === openAgentId) ?? null;

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
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // 标题总结完成 = 该对话已真实落库。若它仍是打开的对话，把侧边栏 tab 同步到
  // 它的 agent 类型,使列表显示并高亮当前对话(与点击历史对话的行为一致)。
  const handleTitle = useCallback(
    (conversationId: string, title: string) => {
      updateTitle(conversationId, title);
      if (conversationId === activeIdRef.current) {
        const conv = conversationsRef.current.find((c) => c.id === conversationId);
        if (conv) setActiveAgentId(conv.agent_id || defaultAgentId);
      }
    },
    [updateTitle, defaultAgentId]
  );

  const { messages, conversationModel, send, stop, isStreaming, loadMessages, clear, regenerate, generateMedia, redownloadGeneration } =
    useChat(activeId, handleStreamEnd, activeIdRef, handleTitle);

  // Per-user model catalog + per-group (llm/image/video) selected models.
  const { models: modelCatalog, reload: reloadModels } = useModels();
  const [selectedModels, setSelectedModels] = useState(EMPTY_SELECTED);
  const [activeKeyIndex, setActiveKeyIndex] = useState(user.activeKeyIndex);
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);

  const handleSelectKey = useCallback(
    async (index: number) => {
      setKeyBusy(true);
      try {
        await api.setActiveKey(index);
        setActiveKeyIndex(index);
        setSelectedModels(EMPTY_SELECTED); // 丢弃旧 key 的选择，等新目录回填
        reloadModels();
        setKeyModalOpen(false);
      } catch {
        // 切换失败：保持原激活项；弹窗留开供重试
      } finally {
        setKeyBusy(false);
      }
    },
    [reloadModels]
  );
  // Catalog loaded → 各组默认选中接口返回的第一个模型(已选过的槽位不动)。
  useEffect(() => {
    setSelectedModels((prev) => fillModelDefaults(prev, modelCatalog));
  }, [modelCatalog]);
  // 进入会话:已存模型若仍在目录中则沿用,否则回落到 llm 组第一个(切 key / 订阅
  // 变更后旧模型可能已不在新目录中,需校验避免选中失效模型)。
  useEffect(() => {
    setSelectedModels((prev) => ({
      ...prev,
      llm: resolveLlmSelection(conversationModel, modelCatalog.llm),
    }));
  }, [conversationModel, modelCatalog]);

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

  // 侧边栏 tab:纯筛选历史列表,任何状态下都不碰当前对话 / hero。
  const handleFilterAgent = useCallback((agentId: string) => {
    setActiveAgentId(agentId);
  }, []);

  // 输入框上方 pill:无条件开一个该 Agent 的新对话;侧边栏筛选不动。
  const handleStartNewChat = useCallback(
    (agentId: string) => {
      setNewAgentId(agentId);
      // Sync the ref BEFORE the next render so in-flight stream events stop
      // rendering into the (now empty) new-chat view immediately.
      activeIdRef.current = null;
      setActiveId(null);
      clear();
      setPreviewContent(null);
    },
    [setActiveId, clear]
  );

  const handlePickOverflow = useCallback(
    async (agentId: string) => {
      await promote(agentId); // 移到子 Agent 首位,持久化 sortOrder
      handleStartNewChat(agentId);
    },
    [promote, handleStartNewChat]
  );

  const handleSelect = useCallback(
    (id: string) => {
      if (id === "__new__") return; // already in new-chat mode
      // A conversation is bound to one agent — sync the switcher to it.
      const conv = conversations.find((c) => c.id === id);
      if (conv) setActiveAgentId(conv.agent_id || defaultAgentId);
      setNewAgentId(null);
      // Sync the ref BEFORE loadMessages: its stale-response guard and the
      // stream-event scoping both compare against activeIdRef synchronously.
      activeIdRef.current = id;
      setActiveId(id);
      clear();
      loadMessages(id);
      setPreviewContent(null);
    },
    [conversations, defaultAgentId, setActiveId, loadMessages, clear]
  );

  // 新对话按钮:永远开默认(通用)Agent 的新对话。
  const handleCreate = useCallback(() => {
    handleStartNewChat(defaultAgentId);
  }, [handleStartNewChat, defaultAgentId]);

  // Send wrapper: creates the server conversation on first message if needed.
  const doSend = useCallback(
    async (content: string, files: PickedFile[] = [], settings?: unknown) => {
      const kind = openAgent?.type || openAgent?.id;
      const dispatch = () => {
        if (kind === "image" || kind === "video") {
          generateMedia(content, kind as "image" | "video", settings, files, selectedModels[kind as "image" | "video"] ?? undefined);
        } else {
          send(content, files, undefined, selectedModels.llm ?? undefined);
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
    [newAgentId, setActiveId, addLocal, send, generateMedia, openAgent, selectedModels]
  );

  const handleDelete = useCallback(
    (id: string) => {
      remove(id);
      if (id === activeId) {
        // Deleting the open conversation drops us into new-chat mode (rather
        // than a dead empty state), so the input can create + send a new
        // conversation instead of silently doing nothing.
        activeIdRef.current = null;
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
          activeIdRef.current = null;
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

  // Sidebar list: filtered to the active agent; prepend a virtual "新对话" entry
  // when in new-chat mode (prepended unconditionally — the hero's agent may
  // differ from the sidebar filter now that pills don't move the filter).
  const sidebarConversations = useMemo(() => {
    const filtered = conversations.filter((c) => c.agent_id === activeAgentId);
    if (!newAgentId) return filtered;
    return [
      { id: "__new__", title: "新对话", agent_id: newAgentId, created_at: "", updated_at: "" },
      ...filtered,
    ];
  }, [newAgentId, conversations, activeAgentId]);

  // 当前 hero Agent 对应的模型分组;切组时各组各自记住上次的选择。
  const modelGroup = groupForKind(openAgent?.type || openAgent?.id);
  const handleModelChange = useCallback(
    (id: string) => setSelectedModels((prev) => ({ ...prev, [modelGroup]: id })),
    [modelGroup]
  );

  return (
    <div className="workspace">
      <div className={`workspace-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <BrandHeader
          user={user}
          onLogout={onLogout}
          onCollapse={() => setSidebarCollapsed(true)}
          onOpenAgentCenter={() => setCenterOpen(true)}
          onOpenKeySettings={() => setKeyModalOpen(true)}
        />
        <Sidebar
          conversations={sidebarConversations}
          installedAgents={installed}
          activeAgentId={activeAgentId}
          onSwitchAgent={handleFilterAgent}
          switchDisabled={isStreaming}
          activeId={newAgentId ? "__new__" : activeId}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onCreate={handleCreate}
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
            onRedownloadGeneration={redownloadGeneration}
            // 预览仅对「文案制作」Agent 开放；通用 / 图片 / 视频不需要。
            onSelectForPreview={
              openAgent?.type === "copywriting" || openAgent?.id === "copywriting"
                ? setPreviewContent
                : undefined
            }
            agent={openAgent}
            inputAbove={
              <AgentSwitcher
                agents={installed}
                activeId={openAgentId}
                onSwitch={handleStartNewChat}
                onPickOverflow={handlePickOverflow}
                disabled={isStreaming}
              />
            }
            userName={user.name}
            modelCatalog={modelCatalog}
            selectedModel={selectedModels[modelGroup]}
            onModelChange={handleModelChange}
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
      {keyModalOpen && (
        <KeySettingsModal
          keys={user.apiKeys}
          activeIndex={activeKeyIndex}
          busy={keyBusy}
          onSelect={handleSelectKey}
          onClose={() => setKeyModalOpen(false)}
        />
      )}
    </div>
  );
}
