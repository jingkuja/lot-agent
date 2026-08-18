import { useCallback, useEffect, useState } from "react";
import type { User } from "../api/client.js";
import { Workspace } from "../pages/Workspace.js";
import { DigitalEmployeeLayout } from "../modules/digital-employee/DigitalEmployeeLayout.js";

interface ProductShellProps {
  user: User;
  onLogout: () => void;
}

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
  const [requestedDigitalConversationId, setRequestedDigitalConversationId] = useState<string | null>(null);
  const isDigitalEmployee = pathname.startsWith("/digital-employee");
  const isDigitalEmployeeChat = pathname === "/digital-employee" || pathname === "/digital-employee/customer-profile";

  useEffect(() => {
    const onPopState = () => setPathname(currentPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setPathname(path);
  }, []);

  return (
    <>
      <div className={isDigitalEmployee ? "product-shell-view is-hidden" : "product-shell-view"} aria-hidden={isDigitalEmployee || undefined}>
        <Workspace
          user={user}
          onLogout={onLogout}
          onNavigateDigitalEmployee={() => navigate("/digital-employee/customer-profile")}
        />
      </div>
      <div className={isDigitalEmployeeChat ? "product-shell-view" : "product-shell-view is-hidden"} aria-hidden={!isDigitalEmployeeChat || undefined}>
        <Workspace
          mode="digitalEmployee"
          user={user}
          onLogout={onLogout}
          onNavigateAssistant={() => navigate("/assistant")}
          onNavigateDigitalEmployee={() => navigate("/digital-employee/profiles")}
          onNavigateDigitalProfile={(id) => navigate(`/digital-employee/profiles/${encodeURIComponent(id)}`)}
          onNavigateDigitalFeature={(feature) => navigate(`/digital-employee/${feature}`)}
          requestedConversationId={requestedDigitalConversationId}
          onRequestedConversationHandled={() => setRequestedDigitalConversationId(null)}
        />
      </div>
      {isDigitalEmployee && !isDigitalEmployeeChat && (
        <DigitalEmployeeLayout
          pathname={pathname}
          user={user}
          onLogout={onLogout}
          onNavigate={navigate}
          onNavigateAssistant={() => navigate("/assistant")}
          onOpenConversation={(id) => {
            setRequestedDigitalConversationId(id);
            navigate("/digital-employee/customer-profile");
          }}
        />
      )}
    </>
  );
}
