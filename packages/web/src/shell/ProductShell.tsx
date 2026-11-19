import { useCallback, useEffect, useState } from "react";
import { COMIC_DIRECTOR_AGENT_ID, COMIC_DRAMA_ROOT } from "@lot-agent/core/comic-drama";
import { ComicDramaWorkspace } from "../modules/comic-drama/ComicDramaWorkspace.js";
import { useI18n } from "../i18n/index.js";
import type { User } from "../api/client.js";
import { Workspace } from "../pages/Workspace.js";
import { DIGITAL_EMPLOYEE_AGENT_ID } from "../modules/digital-employee/conversation-scope.js";
import { EmployeeWorkspace } from "../modules/digital-employee/EmployeeWorkspace.js";
import { TODAY_PATH, normalizeEmployeePath } from "../modules/digital-employee/routes.js";
import { useEmployeeFlags } from "../modules/digital-employee/useEmployeeFlags.js";
import { useEmployeeSummary } from "../modules/digital-employee/useEmployeeSummary.js";
import { useModels } from "../hooks/useModels.js";
import { LlmModelRequiredModal } from "../components/LlmModelRequiredModal.js";

interface ProductShellProps {
  user: User;
  onLogout: () => void;
}

const HIDDEN_AGENT_IDS = [DIGITAL_EMPLOYEE_AGENT_ID, COMIC_DIRECTOR_AGENT_ID];

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
  const employeeFlags = useEmployeeFlags();
  const employeeSummary = useEmployeeSummary();
  const { comicDramaEnabled } = useI18n();
  const isComicPath = pathname === COMIC_DRAMA_ROOT || pathname.startsWith(COMIC_DRAMA_ROOT + "/");
  const isComicDrama = comicDramaEnabled && isComicPath;
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
  useEffect(() => {
    if (isComicPath && !comicDramaEnabled) replacePath("/assistant");
    else replacePath(normalizeEmployeePath(pathname));
  }, [pathname, replacePath, comicDramaEnabled, isComicPath]);

  const openComicDrama = comicDramaEnabled ? () => navigate(COMIC_DRAMA_ROOT) : undefined;
  const showAssistant = !isDigitalEmployee && !isComicDrama;

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
      <div className={showAssistant ? "product-shell-view" : "product-shell-view is-hidden"} aria-hidden={!showAssistant || undefined}>
        <Workspace
          user={user}
          onLogout={onLogout}
          modelCatalog={modelCatalog}
          onNavigateDigitalEmployee={handleOpenDigitalEmployee}
          onNavigateComicDrama={openComicDrama}
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
          dailyScan={employeeFlags.dailyScan}
          schedules={employeeFlags.schedules}
          assignments={employeeFlags.assignments}
          pendingCount={employeeSummary.pending}
          waitingTasks={employeeSummary.waitingTasks}
          onPendingChange={employeeSummary.setPending}
          onLogout={onLogout}
          navigate={navigate}
          replacePath={replacePath}
          onNavigateAssistant={() => navigate("/assistant")}
          onNavigateComicDrama={openComicDrama}
        />
      </div>
      {comicDramaEnabled && <div className={isComicDrama ? "product-shell-view" : "product-shell-view is-hidden"} aria-hidden={!isComicDrama || undefined}>
        <ComicDramaWorkspace key={user.id} user={user} pathname={pathname} active={isComicDrama} navigate={navigate} replacePath={replacePath}
          onLogout={onLogout} onOpenAssistant={() => navigate("/assistant")} onOpenDigitalEmployee={handleOpenDigitalEmployee} models={modelCatalog.video} />
      </div>}
      {llmNoticeTitle && <LlmModelRequiredModal title={llmNoticeTitle} onClose={() => setLlmNoticeTitle(null)} />}
    </>
  );
}
