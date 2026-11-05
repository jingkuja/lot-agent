import { useCallback, useEffect, useState } from "react";
import type { User } from "../api/client.js";
import { Workspace } from "../pages/Workspace.js";
import { DIGITAL_EMPLOYEE_AGENT_ID } from "../modules/digital-employee/conversation-scope.js";
import { EmployeeWorkspace } from "../modules/digital-employee/EmployeeWorkspace.js";
import { TODAY_PATH, normalizeEmployeePath } from "../modules/digital-employee/routes.js";
import { useEmployeeDailyScan } from "../modules/digital-employee/useEmployeeDailyScan.js";
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

/**
 * Tiny history router for the assistant and its precision-management pages.
 * The app intentionally avoids an extra router dependency while preserving
 * real URLs, browser navigation and Electron deep links. Workspace stays
 * mounted while profile management is open, so returning never discards chat.
 */
export function ProductShell({ user, onLogout }: ProductShellProps) {
  const [pathname, setPathname] = useState(currentPath);
  const { models: modelCatalog, loading: modelsLoading, reload: reloadModels } = useModels();
  const [llmNoticeTitle, setLlmNoticeTitle] = useState<string | null>(null);
  const dailyScan = useEmployeeDailyScan();
  const employeeSummary = useEmployeeSummary();
  const isDigitalEmployee = pathname.startsWith("/digital-employee");

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

  // Old links, bookmarks and past chat messages reach their new place.
  useEffect(() => { replacePath(normalizeEmployeePath(pathname)); }, [pathname, replacePath]);

  const handleOpenDigitalEmployee = useCallback(() => {
    const open = (catalog: { llm: unknown[] }) => {
      if (catalog.llm.length === 0) setLlmNoticeTitle("无法打开数字员工");
      else navigate(TODAY_PATH);
    };
    if (modelsLoading) void reloadModels().then(open);
    else open(modelCatalog);
  }, [modelCatalog, modelsLoading, navigate, reloadModels]);

  return (
    <>
      <div className={isDigitalEmployee ? "product-shell-view is-hidden" : "product-shell-view"} aria-hidden={isDigitalEmployee || undefined}>
        <Workspace
          user={user}
          onLogout={onLogout}
          modelCatalog={modelCatalog}
          onNavigateDigitalEmployee={handleOpenDigitalEmployee}
          hiddenAgentIds={HIDDEN_AGENT_IDS}
          digitalEmployeeBadge={employeeSummary.pending}
        />
      </div>
      <div className={isDigitalEmployee ? "product-shell-view" : "product-shell-view is-hidden"} aria-hidden={!isDigitalEmployee || undefined}>
        <EmployeeWorkspace
          user={user}
          modelCatalog={modelCatalog}
          pathname={pathname}
          active={isDigitalEmployee}
          dailyScan={dailyScan}
          pendingCount={employeeSummary.pending}
          onPendingChange={employeeSummary.setPending}
          onLogout={onLogout}
          navigate={navigate}
          replacePath={replacePath}
          onNavigateAssistant={() => navigate("/assistant")}
        />
      </div>
      {llmNoticeTitle && <LlmModelRequiredModal title={llmNoticeTitle} onClose={() => setLlmNoticeTitle(null)} />}
    </>
  );
}
