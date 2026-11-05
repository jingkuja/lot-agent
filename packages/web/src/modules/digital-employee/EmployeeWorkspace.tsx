import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, User } from "../../api/client.js";
import type { ModelCatalog } from "../../hooks/useModels.js";
import { useI18n } from "../../i18n/index.js";
import { Workspace, type WorkspaceContext } from "../../pages/Workspace.js";
import { seedFromRecommendation, seedFromSegment } from "./acquisition/creation-seeds.js";
import type { CreationSeed } from "./acquisition/CreationWorkspacePage.js";
import { employeeApi } from "./api.js";
import { DIGITAL_EMPLOYEE_AGENT_ID, DIGITAL_EMPLOYEE_UNIFIED_SCOPE, digitalEmployeeConversations } from "./conversation-scope.js";
import { CustomersPage } from "./CustomersPage.js";
import { EmployeeChatHome } from "./EmployeeChatHome.js";
import { EmployeeSidebar } from "./EmployeeSidebar.js";
import { readConversationFocus, type EmployeeFocus } from "./focus.js";
import { MarketingMaterialsPage } from "./marketing/MarketingMaterialsPage.js";
import { MarketingPage } from "./MarketingPage.js";
import { CHAT_PATH, employeePath, parseEmployeePath, type EmployeeView } from "./routes.js";
import { SchedulePage } from "./SchedulePage.js";
import { TodayPage } from "./today/TodayPage.js";
import type { CampaignRecommendation, OpportunityItem, TodayResponse } from "./types.js";
import { WorkLogPage } from "./WorkLogPage.js";
import "./employee.css";

const DEFAULT_NAME = "小灵";
const RUNNING_POLL_MS = 5_000;

interface EmployeeWorkspaceProps {
  user: User;
  modelCatalog: ModelCatalog;
  pathname: string;
  /** False while another product area is on screen; the chat stays mounted behind it. */
  active: boolean;
  dailyScan: boolean;
  pendingCount: number;
  onPendingChange: (count: number) => void;
  onLogout: () => void;
  navigate: (path: string) => void;
  replacePath: (path: string) => void;
  onNavigateAssistant: () => void;
}

/** Older module conversations end when the owner leaves them; the employee's own carry on. */
const keepConversation = (conversation: Conversation | undefined) =>
  !conversation || conversation.metadata?.digitalEmployeeFeatureScope === DIGITAL_EMPLOYEE_UNIFIED_SCOPE;

/** One employee: its card, five entries and a conversation that stays mounted under every page. */
export function EmployeeWorkspace({
  user, modelCatalog, pathname, active, dailyScan, pendingCount, onPendingChange, onLogout, navigate, replacePath, onNavigateAssistant,
}: EmployeeWorkspaceProps) {
  const { t } = useI18n();
  const location = useMemo(() => parseEmployeePath(pathname), [pathname]);
  const { view, tab, profileId } = location;

  const [today, setToday] = useState<TodayResponse | null>(null);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [name, setName] = useState(DEFAULT_NAME);
  const [creationSeed, setCreationSeed] = useState<CreationSeed | undefined>();

  const reloadToday = useCallback(async () => {
    try {
      const next = await employeeApi.getToday();
      setToday(next);
      setName(next.employee.name);
      onPendingChange(next.items.length);
      setTodayError(null);
    } catch (reason) {
      setTodayError(reason instanceof Error ? reason.message : "读取失败");
    }
  }, [onPendingChange]);

  useEffect(() => { if (active) void reloadToday(); }, [active, view, reloadToday]);
  const hasRunning = (today?.running.length ?? 0) > 0;
  useEffect(() => {
    if (!active || !hasRunning) return;
    const timer = window.setInterval(() => void reloadToday(), RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, hasRunning, reloadToday]);

  // The object on the open page reaches the conversation when the owner sends. A ref keeps
  // that send, which can start in the same tick as the choice, from reading stale state.
  const [pageFocus, setPageFocusState] = useState<EmployeeFocus | null>(null);
  const pageFocusRef = useRef<EmployeeFocus | null>(null);
  const setPageFocus = useCallback((focus: EmployeeFocus | null) => {
    pageFocusRef.current = focus;
    setPageFocusState(focus);
  }, []);
  // What this session knows newer than the conversation list: null means removed.
  const [focusOverride, setFocusOverride] = useState<{ conversationId: string; focus: EmployeeFocus | null } | null>(null);

  useEffect(() => { setPageFocus(null); }, [pathname, setPageFocus]);

  // Sending leaves the page, which clears its object, before the conversation exists.
  const sendingFocus = useRef<EmployeeFocus | null>(null);
  const beforeDispatch = useCallback(async (conversationId: string) => {
    const focus = sendingFocus.current;
    sendingFocus.current = null;
    if (!focus) return;
    setFocusOverride({ conversationId, focus });
    // A failed write costs the context, not the message.
    await employeeApi.setConversationFocus(conversationId, { type: focus.type, id: focus.id }).catch(() => setFocusOverride(null));
  }, []);

  const openView = useCallback((next: EmployeeView, tail?: string) => navigate(employeePath(next, tail)), [navigate]);
  const openConversation = useCallback((id: string) => openView("chat", id), [openView]);
  const handleSendStart = useCallback(() => {
    sendingFocus.current = pageFocusRef.current;
    navigate(CHAT_PATH);
  }, [navigate]);

  // Keeps a reload on the conversation being read.
  const inChat = view === "chat";
  const lastActiveConversation = useRef<string | null>(null);
  const handleActiveConversation = useCallback((id: string | null) => {
    const closed = id === null && lastActiveConversation.current !== null;
    lastActiveConversation.current = id;
    // Before anything is open, a conversation in the address is still on its way.
    if (!inChat || (id === null && !closed)) return;
    const next = id ? employeePath("chat", id) : CHAT_PATH;
    if (window.location.pathname.startsWith(CHAT_PATH) && window.location.pathname !== next) replacePath(next);
  }, [inChat, replacePath]);

  const openCreation = useCallback((seed: CreationSeed) => {
    setCreationSeed({ ...seed, nonce: Date.now() });
    openView("marketing", "creation");
  }, [openView]);

  const assign = (context: WorkspaceContext, prompt: string, focus?: EmployeeFocus) => {
    if (focus) setPageFocus(focus);
    context.send(prompt);
  };

  const draftOutreach = (context: WorkspaceContext, item: OpportunityItem) => assign(
    context,
    t("给{0}写一条跟进话术：{1}", [item.customerName, item.title]),
    { type: "customer", id: item.profileId, label: item.customerName },
  );

  const currentFocus = (context: WorkspaceContext) => {
    if (pageFocus) return pageFocus;
    const id = context.activeConversationId;
    if (id && focusOverride?.conversationId === id) return focusOverride.focus;
    return readConversationFocus(context.activeConversation?.metadata);
  };

  const clearFocus = (context: WorkspaceContext) => {
    if (pageFocus) { setPageFocus(null); return; }
    const id = context.activeConversationId;
    if (!id) return;
    setFocusOverride({ conversationId: id, focus: null });
    void employeeApi.clearDigitalEmployeeContext(id).catch(() => setFocusOverride(null));
  };

  const page = (context: WorkspaceContext) => {
    const openProfile = (id: string) => openView("customers", id);
    if (view === "customers") {
      return <CustomersPage
        employeeName={name}
        tab={tab}
        profileId={profileId}
        onNavigate={(tail) => openView("customers", tail)}
        onFocus={setPageFocus}
        onCreateContent={(segment) => openCreation(seedFromSegment(segment))}
        onDraftOutreach={(profile) => assign(context, t("给{0}写一条跟进话术", [profile.displayName]), {
          type: "customer", id: profile.id, label: profile.displayName,
        })}
      />;
    }
    if (view === "marketing") {
      return <MarketingPage
        tab={tab}
        seed={creationSeed}
        onNavigate={(tail) => openView("marketing", tail)}
        onOpenCreation={openCreation}
        onOpenSegments={() => openView("customers", "segments")}
        onOpenMaterials={() => openView("materials")}
        onFocus={setPageFocus}
      />;
    }
    if (view === "materials") {
      return <MarketingMaterialsPage onSelect={(product) => setPageFocus({ type: "product", id: product.id, label: product.name })} />;
    }
    if (view === "work-log") {
      return <WorkLogPage
        key={tab}
        initialTab={tab}
        conversations={digitalEmployeeConversations(context.conversations)}
        activeConversationId={context.activeConversationId}
        hasMore={context.hasMore}
        loadingMore={context.loadingMore}
        onLoadMore={context.loadMore}
        onOpenConversation={openConversation}
        onDeleteConversation={context.deleteConversation}
        onOpenProfile={openProfile}
        onDraftOutreach={(item) => draftOutreach(context, item)}
      />;
    }
    if (view === "schedule") return <SchedulePage dailyScan={dailyScan} onNameChange={setName} />;
    return <TodayPage
      data={today}
      error={todayError}
      busy={context.isStreaming}
      onReload={reloadToday}
      onOpenConversation={openConversation}
      onOpenProfile={openProfile}
      onOpenCustomers={() => openView("customers")}
      onOpenSnoozed={() => openView("work-log", "snoozed")}
      onOpenLink={navigate}
      onDraftOutreach={(item) => draftOutreach(context, item)}
      onAssign={(prompt) => assign(context, prompt)}
      onRefineRecommendation={(item: CampaignRecommendation) => openCreation(seedFromRecommendation(item))}
    />;
  };

  return <Workspace
    user={user}
    modelCatalog={modelCatalog}
    onLogout={onLogout}
    lockedAgentId={DIGITAL_EMPLOYEE_AGENT_ID}
    resetKey={view}
    keepConversation={keepConversation}
    onNavigateAssistant={onNavigateAssistant}
    onNavigateDigitalEmployee={() => openView("today")}
    onSendStart={handleSendStart}
    beforeDispatch={beforeDispatch}
    onActiveConversationChange={handleActiveConversation}
    digitalEmployeeBadge={pendingCount}
    requestedConversationId={location.conversationId}
    sidebar={(context) => <EmployeeSidebar
      name={name}
      running={today?.running ?? []}
      waiting={pendingCount}
      view={view}
      isStreaming={context.isStreaming}
      onNavigate={openView}
      onNewConversation={() => {
        navigate(CHAT_PATH);
        context.newConversation();
      }}
      onStreamEnd={() => {
        setFocusOverride(null);
        void reloadToday();
      }}
    />}
    inputAbove={(context) => {
      const focus = currentFocus(context);
      return focus ? <div className="de-chat-actions-row">
        <span className="de-chat-current-customer">
          {t("当前对象：")}<strong>{focus.label}</strong>
          <button type="button" onClick={() => clearFocus(context)} aria-label={t("移除当前对象")}>×</button>
        </span>
      </div> : undefined;
    }}
    emptyDashboard={(context) => <EmployeeChatHome name={name} onPrompt={context.send} />}
    overlay={active && view !== "chat" ? page : undefined}
  />;
}
