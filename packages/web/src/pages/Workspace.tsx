import { useI18n } from "../i18n/index.js";
import { KnowledgePanel } from "../modules/knowledge/KnowledgePanel.js";
import { knowledgeApi } from "../modules/knowledge/api.js";
import { useEffect, useCallback, useRef, useState, useMemo, type ReactNode } from "react";
import { Sidebar } from "../components/Sidebar.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { BrandHeader } from "../components/BrandHeader.js";
import { PreviewPanel } from "../components/PreviewPanel.js";
import { ArtifactGallery, type Artifact } from "../components/ArtifactGallery.js";
import { AgentSwitchDialog } from "../components/AgentSwitchDialog.js";
import { AGENT_ICONS, agentIconKind } from "../lib/agent-icons.js";
import { useConversations } from "../hooks/useConversations.js";
import { useChat } from "../hooks/useChat.js";
import { useAgents } from "../hooks/useAgents.js";
import type { ModelCatalog } from "../hooks/useModels.js";
import { useDesktopShortcuts } from "../hooks/useDesktopShortcuts.js";
import { api, type Conversation, type KnowledgeBaseRef, type User, type PickedFile } from "../api/client.js";
import { GENERAL_ID } from "../lib/agent-order.js";
import type { ComposeLayout } from "../lib/image-settings.js";
import { EMPTY_SELECTED, fillModelDefaults, groupForKind, resolveImageSelection, resolveLlmSelection } from "../lib/model-defaults.js";

/** Below this width the sidebar overlays the main area instead of sitting beside it. */
const NARROW_SCREEN = "(max-width: 760px)";

/** What a product built on the Workspace can see and do from its slots. */
export interface WorkspaceContext {
  conversations: Conversation[];
  activeConversation?: Conversation;
  activeConversationId: string | null;
  isStreaming: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  newConversation: () => void;
  openConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  refreshConversations: () => void;
  send: (prompt: string) => void;
  llmModelId: string | null;
}

type WorkspaceSlot = (context: WorkspaceContext) => ReactNode;

interface WorkspaceProps {
  user: User;
  modelCatalog: ModelCatalog;
  onLogout: () => void;
  onNavigateDigitalEmployee?: () => void;
  onNavigateAssistant?: () => void;
  /** Agents with their own product entry, kept out of the launcher. */
  hiddenAgentIds?: string[];
  /** Serves this one Agent: no launcher, and the sidebar slot replaces the conversation list. */
  lockedAgentId?: string;
  /** Sent when a conversation is created; the server decides what it means. */
  newConversationScope?: string;
  /** A change starts a new chat unless keepConversation holds for the open one. */
  resetKey?: string;
  keepConversation?: (conversation: Conversation | undefined) => boolean;
  sidebar?: WorkspaceSlot;
  inputAbove?: WorkspaceSlot;
  emptyDashboard?: WorkspaceSlot;
  /** A page over the chat. The chat stays mounted beneath it, so its draft and stream survive. */
  overlay?: WorkspaceSlot;
  /** Runs as soon as the user sends, before anything is created. */
  onSendStart?: () => void;
  /** Runs once the conversation exists, before the message goes out. */
  beforeDispatch?: (conversationId: string) => Promise<void>;
  onActiveConversationChange?: (id: string | null) => void;
  digitalEmployeeBadge?: number;
  requestedConversationId?: string | null;
  onRequestedConversationHandled?: () => void;
}

export function Workspace({
  user,
  modelCatalog,
  onLogout,
  onNavigateDigitalEmployee,
  onNavigateAssistant,
  hiddenAgentIds,
  lockedAgentId,
  newConversationScope,
  resetKey,
  keepConversation,
  sidebar,
  inputAbove,
  emptyDashboard,
  overlay,
  onSendStart,
  beforeDispatch,
  onActiveConversationChange,
  digitalEmployeeBadge,
  requestedConversationId,
  onRequestedConversationHandled,
}: WorkspaceProps) {
  const { t } = useI18n();
  const { agents } = useAgents(true);
  const isLocked = Boolean(lockedAgentId);
  const assistantAgents = useMemo(
    () => agents.filter((agent) => !hiddenAgentIds?.includes(agent.id)),
    [agents, hiddenAgentIds]
  );
  const lockedAgent = agents.find((agent) => agent.id === lockedAgentId) ?? null;

  // 所有可见 Agent 均可直接使用；通用助手作为默认入口。
  const orderedAgents = useMemo(() => {
    if (isLocked) return lockedAgent ? [lockedAgent] : [];
    const general = assistantAgents.find((a) => a.type === "general" || a.id === GENERAL_ID);
    if (!general) return assistantAgents;
    return [general, ...assistantAgents.filter((a) => a !== general)];
  }, [assistantAgents, lockedAgent, isLocked]);

  const defaultAgentId = lockedAgentId ?? orderedAgents[0]?.id ?? GENERAL_ID;
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

  // The open chat and sidebar always share the same selected Agent.
  const openConversation = conversations.find((c) => c.id === activeId);
  const openAgentId =
    newAgentId ??
    openConversation?.agent_id ??
    activeAgentId;
  const openAgent = agents.find((a) => a.id === openAgentId) ?? lockedAgent;

  const [artifacts] = useState<Artifact[]>([]);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  // On a narrow screen the sidebar starts collapsed and, when opened, covers the main area;
  // opening an agent or a conversation from it closes it again.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia?.(NARROW_SCREEN).matches ?? false);
  useEffect(() => {
    if (window.matchMedia?.(NARROW_SCREEN).matches) setSidebarCollapsed(true);
  }, [openAgentId, activeId]);
  const [knowledgeOpen, setKnowledgeOpen] = useState(() => new URLSearchParams(window.location.search).get("knowledge") === "1");
  const [knowledgeSection, setKnowledgeSection] = useState<"libraries" | "digital-twin">("libraries");
  const openKnowledge = useCallback((section: "libraries" | "digital-twin" = "libraries") => {
    setKnowledgeSection(section);
    setKnowledgeOpen(true);
  }, []);
  const [knowledgeAttachment, setKnowledgeAttachment] = useState<{ id: string; file: File }>();
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !(event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true]"))) { event.preventDefault(); openKnowledge(); }
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [openKnowledge]);
  const [knowledgeAvailable, setKnowledgeAvailable] = useState(false);
  useEffect(() => { let live = true; void knowledgeApi.status().then(() => { if (live) setKnowledgeAvailable(true); }).catch(() => {}); return () => { live = false; }; }, [user.id]);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [studioRevision, setStudioRevision] = useState(0);
  const creatingConversation = useRef(false);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [balanceRefreshKey, setBalanceRefreshKey] = useState(0);

  const handleStreamEnd = useCallback(() => {
    // Pull in the completed conversation's persisted messages/order. A later
    // title SSE event updates the first-turn title separately via handleTitle.
    refresh();
    // Usage for the completed turn has been persisted before stream_end. Signal
    // the header balance to fetch the latest remaining points as well.
    setBalanceRefreshKey((key) => key + 1);
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

  const {
    channel, messages, conversationModel, conversationKnowledgeBases, setConversationKnowledgeBases, send, stop, isStreaming, loadMessages, clear,
    regenerate, generateMedia, redownloadGeneration, composeGeneration, composeImages, redoGenerationImages, exportGeneration, editPoster, previewPoster,
    whiteBackground,
  } =
    useChat(activeId, handleStreamEnd, activeIdRef, handleTitle);

  const knowledgeUpdateSeq = useRef(0);
  const handleKnowledgeBasesChange = useCallback(
    (items: KnowledgeBaseRef[]) => {
      const previous = conversationKnowledgeBases;
      const conversationId = activeIdRef.current;
      const seq = ++knowledgeUpdateSeq.current;
      setConversationKnowledgeBases(items);
      if (!conversationId) return;
      void api.setConversationKnowledgeBases(conversationId, items.map((item) => item.id), items[0]?.sourceTypes).catch(() => {
        // Revert only if this is still the latest edit for the same open chat.
        if (seq === knowledgeUpdateSeq.current && activeIdRef.current === conversationId) {
          setConversationKnowledgeBases(previous);
        }
      });
    },
    [conversationKnowledgeBases, setConversationKnowledgeBases]
  );

  // Per-user model catalog + per-group (llm/image/video) selected models.
  const [selectedModels, setSelectedModels] = useState(EMPTY_SELECTED);
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

  // Agent selection controls both history and the next conversation.
  const [newProjectId, setNewProjectId] = useState<string | null>(null);
  // A link can open an Agent directly, for example a draft prepared in another Agent's chat.
  const linkedAgentId = useRef(isLocked ? null : new URLSearchParams(window.location.search).get("agent"));

  const [imageDraftRevision, setImageDraftRevision] = useState(0);
  const handleStartNewChat = useCallback(
    (agentId: string) => {
      if (creatingConversation.current) return;
      setActiveAgentId(agentId);
      setImageDraftRevision((value) => value + 1);
      if (agentId === "marketing_video" || agentId === "digital_presenter") setStudioRevision((value) => value + 1);
      setNewProjectId(null);
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

  // Some products bind a conversation to the page it started on, so leaving that
  // page must not carry its objects or tools along, even though this Workspace stays mounted.
  const previousResetKey = useRef(resetKey);
  useEffect(() => {
    const previous = previousResetKey.current;
    previousResetKey.current = resetKey;
    if (!lockedAgentId || previous === resetKey || keepConversation?.(openConversation)) return;
    handleStartNewChat(lockedAgentId);
  }, [resetKey, handleStartNewChat, lockedAgentId, keepConversation, openConversation]);

  // Desktop shortcut: Cmd/Ctrl+N opens a fresh chat for the agent currently
  // on screen. The Agent has no user-selectable API key settings.
  useDesktopShortcuts({
    onNewChat: () => handleStartNewChat(openAgentId),
  });

  const handleSwitchAgent = useCallback((agentId: string) => {
    if (creatingConversation.current || agentId === openAgentId) return;
    if (!assistantAgents.some((agent) => agent.id === agentId)) return;
    if (activeId || messages.length > 0 || isStreaming || hasDraft) {
      setPendingAgentId(agentId);
      return;
    }
    handleStartNewChat(agentId);
  }, [openAgentId, assistantAgents, activeId, messages.length, isStreaming, hasDraft, handleStartNewChat]);

  useEffect(() => {
    const agentId = linkedAgentId.current;
    if (!agentId || !assistantAgents.some((agent) => agent.id === agentId)) return;
    linkedAgentId.current = null;
    handleStartNewChat(agentId);
  }, [assistantAgents, handleStartNewChat]);

  const handleSelect = useCallback(
    (id: string) => {
      if (creatingConversation.current || id === activeId || id === "__new__") return; // already in new-chat mode
      // A conversation is bound to one agent — sync the switcher to it.
      const conv = conversations.find((c) => c.id === id);
      if (conv) setActiveAgentId(conv.agent_id || defaultAgentId);
      setNewAgentId(null);
      // Sync the ref BEFORE loadMessages: its stale-response guard and the
      // stream-event scoping both compare against activeIdRef synchronously.
      activeIdRef.current = id;
      setActiveId(id);
      setImageDraftRevision((value) => value + 1);
      clear();
      loadMessages(id);
      setPreviewContent(null);
    },
    [conversations, activeId, defaultAgentId, setActiveId, loadMessages, clear]
  );

  const handledConversationRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedConversationId) {
      handledConversationRequest.current = null;
      return;
    }
    if (!isLocked || handledConversationRequest.current === requestedConversationId) return;
    handledConversationRequest.current = requestedConversationId;
    handleSelect(requestedConversationId);
    onRequestedConversationHandled?.();
  }, [handleSelect, isLocked, onRequestedConversationHandled, requestedConversationId]);

  useEffect(() => { onActiveConversationChange?.(activeId); }, [activeId, onActiveConversationChange]);

  // New chats stay with the currently selected Agent.
  const handleCreate = useCallback(() => {
    handleStartNewChat(openAgentId);
  }, [handleStartNewChat, openAgentId]);

  // Creates the server conversation for a new chat and makes it the open one; null while one is already being made.
  const createNewConversation = useCallback(async (): Promise<string | null> => {
    if (!newAgentId || creatingConversation.current) return null;
    const featureScope = newAgentId === lockedAgentId ? newConversationScope : undefined;
    creatingConversation.current = true;
    setIsCreatingConversation(true);
    let conv;
    try {
      conv = await api.createConversation(undefined, newAgentId, featureScope, newProjectId ?? undefined);
      if (newAgentId === "general") await window.lotDesktop?.bindLocalPermission(conv.id);
    } finally {
      creatingConversation.current = false;
      setIsCreatingConversation(false);
    }
    activeIdRef.current = conv.id;
    setActiveId(conv.id);
    setNewAgentId(null);
    // The server list omits 0-message conversations, so optimistically
    // surface this one in the sidebar instead of refreshing (which wouldn't
    // return it yet). stream_end triggers a real refresh once it has content.
    addLocal(conv);
    return conv.id;
  }, [newAgentId, newProjectId, lockedAgentId, newConversationScope, setActiveId, addLocal]);

  // Send wrapper: creates the server conversation on first message if needed.
  const doSend = useCallback(
    async (
      content: string,
      files: PickedFile[] = [],
      settings?: unknown,
      knowledgeBases: KnowledgeBaseRef[] = [],
      requestId?: string,
    ) => {
      const kind = openAgent?.type || openAgent?.id;
      const dispatch = () => {
        if (kind === "image" || kind === "video") {
          const modelId = kind === "image" ? resolveImageSelection(selectedModels.image, modelCatalog.image) : selectedModels.video;
          return generateMedia(content, kind === "image" ? "image" : "video", settings, files, modelId ?? undefined, [], requestId);
        } else {
          send(content, files, undefined, selectedModels.llm ?? undefined, knowledgeBases);
        }
      };
      if (newAgentId) {
        if (creatingConversation.current) return;
        onSendStart?.();
        const id = await createNewConversation();
        if (!id) return;
        await beforeDispatch?.(id);
        if (activeIdRef.current !== id) return;
        return dispatch();
      }
      onSendStart?.();
      const id = activeIdRef.current;
      if (id) await beforeDispatch?.(id);
      if (activeIdRef.current !== id) return;
      return dispatch();
    },
    [newAgentId, send, generateMedia, openAgent, selectedModels, modelCatalog, onSendStart, beforeDispatch, createNewConversation]
  );

  // 图片合成 from the composer works in a new chat too (picking from 个人素材), so it creates the conversation first.
  const handleComposeImages = useCallback(async (urls: string[], layout: ComposeLayout, gap: boolean, prompt: string) => {
    let id = activeIdRef.current;
    if (newAgentId) {
      if (creatingConversation.current) return "合成失败，请稍后重试";
      try {
        id = await createNewConversation();
      } catch {
        return "合成失败，请稍后重试";
      }
    }
    if (!id) return "合成失败，请稍后重试";
    return composeImages(id, urls, layout, gap, prompt);
  }, [newAgentId, createNewConversation, composeImages]);

  // Edits happen inside an existing image conversation, so no conversation is created here.
  const handleEditImage = useCallback((prompt: string, imageUrl: string, settings?: unknown) => {
    const modelId = resolveImageSelection(selectedModels.image, modelCatalog.image);
    generateMedia(prompt, "image", settings, [], modelId ?? undefined, [imageUrl]);
  }, [generateMedia, selectedModels.image, modelCatalog.image]);

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

  // History always belongs to the current Agent.
  const sidebarConversations = useMemo(() => {
    const filtered = conversations.filter((c) => c.agent_id === activeAgentId);
    if (!newAgentId) return filtered;
    return [
      { id: "__new__", title: "新对话", project_id: newProjectId, agent_id: newAgentId, created_at: "", updated_at: "" },
      ...filtered,
    ];
  }, [newAgentId, newProjectId, conversations, activeAgentId]);
  // 当前 hero Agent 对应的模型分组;切组时各组各自记住上次的选择。
  const modelGroup = groupForKind(openAgent?.type || openAgent?.id);
  const handleModelChange = useCallback(
    (id: string) => setSelectedModels((prev) => ({ ...prev, [modelGroup]: id })),
    [modelGroup]
  );

  const context: WorkspaceContext = {
    conversations,
    activeConversation: openConversation,
    activeConversationId: activeId,
    isStreaming,
    hasMore,
    loadingMore,
    loadMore,
    newConversation: () => handleStartNewChat(openAgentId),
    openConversation: handleSelect,
    deleteConversation: handleDelete,
    refreshConversations: () => void refresh(),
    send: (prompt) => void doSend(prompt),
    llmModelId: selectedModels.llm ?? null,
  };

  return (
    <div className="workspace">
      {knowledgeOpen && <KnowledgePanel initialSection={knowledgeSection} onClose={() => setKnowledgeOpen(false)} onUse={(file) => { setKnowledgeAttachment({ id: crypto.randomUUID(), file }); setKnowledgeOpen(false); }} />}
      <div className={`workspace-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <BrandHeader
          user={user}
          onLogout={onLogout}
          onCollapse={() => setSidebarCollapsed(true)}
          onOpenDigitalTwin={() => openKnowledge("digital-twin")}
          onOpenAssistant={isLocked ? onNavigateAssistant : () => {}}
          onOpenDigitalEmployee={onNavigateDigitalEmployee}
          activeModule={isLocked ? "digitalEmployee" : "assistant"}
          balanceRefreshKey={balanceRefreshKey}
          digitalEmployeeBadge={digitalEmployeeBadge}
          onOpenKnowledgeBase={() => {
            const popup = window.open("about:blank", "_blank");
            void api.getKnowledgeBaseLink()
              .then(({ url }) => {
                if (url === "/?knowledge=1") { popup?.close(); openKnowledge(); return; }
                if (popup) {
                  popup.opener = null;
                  popup.location.href = url;
                }
                else window.location.href = url;
              })
              .catch(() => popup?.close());
          }}
        />
        {sidebar ? sidebar(context) : (
          <Sidebar
            conversations={sidebarConversations}
            agents={assistantAgents}
            activeAgentId={activeAgentId}
            onSwitchAgent={handleSwitchAgent}
            switchDisabled={isCreatingConversation}
            activeId={newAgentId ? "__new__" : activeId}
            onSelect={handleSelect}
            onDelete={handleDelete}
            onCreate={handleCreate}
            onCreateInProject={(projectId) => {
              handleStartNewChat(activeAgentId);
              setNewProjectId(projectId);
            }}
            onMove={async (id, projectId) => {
              await api.moveConversation(id, projectId);
              await refresh();
            }}
            onLoadMore={loadMore}
            hasMore={hasMore}
            loadingMore={loadingMore}
          />
        )}
      </div>

      {/* Pointer-only: the sidebar's own collapse button serves the keyboard. */}
      {!sidebarCollapsed && <div className="workspace-sidebar-backdrop" aria-hidden="true" onClick={() => setSidebarCollapsed(true)} />}
      <div className="workspace-main">
        {sidebarCollapsed && (
          <button
            className="sidebar-expand"
            onClick={() => setSidebarCollapsed(false)}
            title={t("展开侧栏")}
            aria-label={t("展开侧栏")}
          >
            ›
          </button>
        )}
        <div className={`workspace-chat ${overlay ? "has-overlay" : ""}`}>
          {overlay && <div className="workspace-overlay">{overlay(context)}</div>}
          {!isLocked && openAgent && (
            <header className={`workspace-agent-header ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
              <span className={`agent-pill-icon agent-pill-icon--${agentIconKind(openAgent)}`} aria-hidden>
                {AGENT_ICONS[agentIconKind(openAgent)]}
              </span>
              <div className="workspace-agent-identity">
                <span>{t("当前 Agent")}</span>
                <strong>{t(openAgent.name)}</strong>
              </div>
              <span className="workspace-agent-description">{t(openAgent.description)}</span>
            </header>
          )}
          <ChatPanel
            key={openAgentId === "marketing_video" || openAgentId === "digital_presenter" ? `${openAgentId}:${studioRevision}` : openAgentId}
            onDraftChange={setHasDraft}
            attachment={knowledgeAttachment}
            onAttachmentConsumed={() => setKnowledgeAttachment(undefined)}
            onManageKnowledge={knowledgeAvailable ? () => openKnowledge() : undefined}
            messages={messages}
            onSend={doSend}
            imageDraftRevision={imageDraftRevision}
            onStop={stop}
            isStreaming={isStreaming}
            activeConversationId={activeId}
            onNewVideo={handleCreate}
            videoPublication={conversations.find((c) => c.id === activeId)?.metadata?.videoPublication}
            readOnly={channel === "feishu"}
            onRegenerate={channel === "feishu" ? undefined : regenerate}
            onRedownloadGeneration={redownloadGeneration}
            onComposeGeneration={composeGeneration}
            onComposeImages={handleComposeImages}
            onRedoGeneration={redoGenerationImages}
            onExportGeneration={exportGeneration}
            onEditPoster={editPoster}
            onPreviewPoster={previewPoster}
            onWhiteBackground={whiteBackground}
            onEditImage={handleEditImage}
            // 预览仅对「文案制作」Agent 开放；通用 / 图片 / 视频不需要。
            onSelectForPreview={
              openAgent?.type === "copywriting" || openAgent?.id === "copywriting"
                ? setPreviewContent
                : undefined
            }
            agent={openAgent}
            inputAbove={inputAbove?.(context)}
            userName={user.name}
            userId={user.id}
            modelCatalog={modelCatalog}
            selectedModel={selectedModels[modelGroup]}
            onModelChange={handleModelChange}
            knowledgeBases={conversationKnowledgeBases}
            onKnowledgeBasesChange={handleKnowledgeBasesChange}
            emptyDashboard={emptyDashboard?.(context)}
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
      {pendingAgentId && (
        <AgentSwitchDialog
          currentName={t(openAgent?.name ?? "通用助手")}
          nextName={t(agents.find((agent) => agent.id === pendingAgentId)?.name ?? pendingAgentId)}
          hasDraft={hasDraft}
          isStreaming={isStreaming}
          onCancel={() => setPendingAgentId(null)}
          onConfirm={() => {
            handleStartNewChat(pendingAgentId);
            setPendingAgentId(null);
          }}
        />
      )}
    </div>
  );
}
