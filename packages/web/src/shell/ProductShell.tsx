import { useCallback, useEffect, useState } from "react";
import type { User } from "../api/client.js";
import { Workspace } from "../pages/Workspace.js";
import { DIGITAL_EMPLOYEE_AGENT_ID } from "../modules/digital-employee/conversation-scope.js";
import { DigitalEmployeeLayout } from "../modules/digital-employee/DigitalEmployeeLayout.js";
import { EmployeeWorkspace } from "../modules/digital-employee/EmployeeWorkspace.js";
import { LegacyDigitalEmployeeWorkspace } from "../modules/digital-employee/LegacyDigitalEmployeeWorkspace.js";
import { TODAY_PATH, normalizeEmployeePath } from "../modules/digital-employee/routes.js";
import { useEmployeeFlags } from "../modules/digital-employee/useEmployeeFlags.js";
import { useEmployeeSummary } from "../modules/digital-employee/useEmployeeSummary.js";
import { useModels } from "../hooks/useModels.js";
import { LlmModelRequiredModal } from "../components/LlmModelRequiredModal.js";

interface ProductShellProps {
  user: User;
  onLogout: () => void;
}

/** The digital employee has its own entry, so the assistant's launcher leaves it out. */
const HIDDEN_AGENT_IDS = [DIGITAL_EMPLOYEE_AGENT_ID];

function currentPath(): string {
  return window.location.pathname || "/assistant";
}

function digitalEmployeeFeatureFor(pathname: string) {
  if (pathname.startsWith("/digital-employee/copy")) return "copy" as const;
  if (pathname.startsWith("/digital-employee/acquisition") || pathname.startsWith("/digital-employee/follow-ups")) return "acquisition" as const;
  if (pathname === "/digital-employee" || pathname.startsWith("/digital-employee/marketing-materials")) return "marketing-materials" as const;
  return "customer-profile" as const;
}

function digitalEmployeeChatPath(feature: ReturnType<typeof digitalEmployeeFeatureFor>) {
  return feature === "copy" || feature === "acquisition"
    ? `/digital-employee/${feature}/chat`
    : `/digital-employee/${feature}`;
}

function digitalEmployeeManagementPath(feature: ReturnType<typeof digitalEmployeeFeatureFor>) {
  if (feature === "marketing-materials") return "/digital-employee/marketing-materials/manage";
  if (feature === "customer-profile") return "/digital-employee/profiles";
  return `/digital-employee/${feature}`;
}

/**
 * Tiny history router for the assistant and its precision-management pages.
 * The app intentionally avoids an extra router dependency while preserving
 * real URLs, browser navigation and Electron deep links. Workspace stays
 * mounted while profile management is open, so returning never discards chat.
 */
export function ProductShell({ user, onLogout }: ProductShellProps) {
  const [pathname, setPathname] = useState(currentPath);
  const [requestedDigitalConversationId, setRequestedDigitalConversationId] = useState<string | null>(null);
  const { models: modelCatalog, loading: modelsLoading, reload: reloadModels } = useModels();
  const [llmNoticeTitle, setLlmNoticeTitle] = useState<string | null>(null);
  const flags = useEmployeeFlags();
  const employeeSummary = useEmployeeSummary(flags.workspace);
  const isDigitalEmployee = pathname.startsWith("/digital-employee");
  const isDigitalEmployeeChat = pathname === "/digital-employee" || pathname === "/digital-employee/customer-profile" ||
    pathname === "/digital-employee/marketing-materials" || pathname === "/digital-employee/copy/chat" ||
    pathname === "/digital-employee/acquisition/chat";
  const digitalEmployeeFeature = digitalEmployeeFeatureFor(pathname);

  useEffect(() => {
    const onPopState = () => setPathname(currentPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setPathname(path);
  }, []);

  const replacePath = useCallback((path: string) => {
    if (window.location.pathname !== path) window.history.replaceState({}, "", path);
    setPathname(path);
  }, []);

  // Old links reach their new place, and new links still work on the older interface.
  useEffect(() => {
    if (flags.ready) replacePath(normalizeEmployeePath(pathname, flags.workspace));
  }, [flags.ready, flags.workspace, pathname, replacePath]);

  const requireLlm = useCallback((next: () => void, title: string) => {
    const openNoticeIfMissing = (catalog: { llm: unknown[] }) => {
      if (catalog.llm.length === 0) setLlmNoticeTitle(title);
      else next();
    };
    if (modelsLoading) {
      void reloadModels().then(openNoticeIfMissing);
      return;
    }
    openNoticeIfMissing(modelCatalog);
  }, [modelCatalog, modelsLoading, reloadModels]);

  const navigateWithModelGuard = useCallback((path: string) => {
    const needsLlm = path.startsWith("/digital-employee/acquisition") || path.startsWith("/digital-employee/follow-ups");
    if (!needsLlm) {
      navigate(path);
      return;
    }
    requireLlm(() => navigate(path), "无法打开商机雷达");
  }, [navigate, requireLlm]);

  const handleOpenDigitalEmployee = useCallback((targetPath?: string) => {
    const path = targetPath ?? (flags.workspace ? TODAY_PATH : "/digital-employee/marketing-materials");
    requireLlm(() => navigate(path), "无法打开数字员工");
  }, [flags.workspace, navigate, requireLlm]);

  const handleOpenDigitalFeature = useCallback((feature: string) => {
    navigateWithModelGuard(`/digital-employee/${feature}`);
  }, [navigateWithModelGuard]);

  const clearRequestedConversation = useCallback(() => setRequestedDigitalConversationId(null), []);

  return (
    <>
      <div className={isDigitalEmployee ? "product-shell-view is-hidden" : "product-shell-view"} aria-hidden={isDigitalEmployee || undefined}>
        <Workspace
          user={user}
          onLogout={onLogout}
          modelCatalog={modelCatalog}
          onNavigateDigitalEmployee={() => handleOpenDigitalEmployee()}
          hiddenAgentIds={HIDDEN_AGENT_IDS}
          digitalEmployeeBadge={employeeSummary.pending}
        />
      </div>
      {flags.ready && flags.workspace && (
        <div className={isDigitalEmployee ? "product-shell-view" : "product-shell-view is-hidden"} aria-hidden={!isDigitalEmployee || undefined}>
          <EmployeeWorkspace
            user={user}
            modelCatalog={modelCatalog}
            pathname={pathname}
            active={isDigitalEmployee}
            dailyScan={flags.dailyScan}
            pendingCount={employeeSummary.pending}
            onPendingChange={employeeSummary.setPending}
            onLogout={onLogout}
            navigate={navigate}
            replacePath={replacePath}
            onNavigateAssistant={() => navigate("/assistant")}
          />
        </div>
      )}
      {flags.ready && !flags.workspace && (
        <div className={isDigitalEmployeeChat ? "product-shell-view" : "product-shell-view is-hidden"} aria-hidden={!isDigitalEmployeeChat || undefined}>
          <LegacyDigitalEmployeeWorkspace
            user={user}
            modelCatalog={modelCatalog}
            onLogout={onLogout}
            feature={digitalEmployeeFeature}
            unifiedEnabled={flags.unified}
            onNavigateAssistant={() => navigate("/assistant")}
            onOpenManagement={() => handleOpenDigitalEmployee(digitalEmployeeManagementPath(digitalEmployeeFeature))}
            onOpenProfile={(id) => navigate(`/digital-employee/profiles/${encodeURIComponent(id)}`)}
            onOpenFeature={handleOpenDigitalFeature}
            requestedConversationId={requestedDigitalConversationId}
            onRequestedConversationHandled={clearRequestedConversation}
          />
        </div>
      )}
      {flags.ready && !flags.workspace && isDigitalEmployee && !isDigitalEmployeeChat && (
        <DigitalEmployeeLayout
          pathname={pathname}
          user={user}
          onLogout={onLogout}
          onNavigate={navigateWithModelGuard}
          onOpenDigitalEmployee={() => handleOpenDigitalEmployee(digitalEmployeeManagementPath(digitalEmployeeFeature))}
          onNavigateAssistant={() => navigate("/assistant")}
          onOpenConversation={(id) => {
            setRequestedDigitalConversationId(id);
            navigateWithModelGuard(digitalEmployeeChatPath(digitalEmployeeFeature));
          }}
        />
      )}
      {llmNoticeTitle && <LlmModelRequiredModal title={llmNoticeTitle} onClose={() => setLlmNoticeTitle(null)} />}
    </>
  );
}
