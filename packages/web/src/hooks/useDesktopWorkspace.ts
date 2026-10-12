import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalPermissionMode, LocalWorkspaceState } from "../types/desktop.js";

export function useDesktopWorkspace(conversationId: string | null, enabled: boolean) {
  const desktop = enabled ? window.lotDesktop : undefined;
  const [snapshot, setSnapshot] = useState<{ id: string | null; state: LocalWorkspaceState } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    if (!desktop) return;
    const current = ++revision.current;
    const state = await desktop.getLocalWorkspace(conversationId);
    if (current === revision.current) setSnapshot({ id: conversationId, state });
  }, [desktop, conversationId]);
  useEffect(() => {
    setError(false);
    const poll = () => { void refresh().catch(() => {}); };
    poll();
    window.addEventListener("focus", poll);
    const timer = window.setInterval(poll, 500);
    return () => { revision.current++; window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [refresh]);
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError(false);
    try { await action(); await refresh(); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  return {
    available: !!desktop,
    state: desktop && snapshot?.id === conversationId ? snapshot.state : null,
    busy, error,
    choose: () => change(() => desktop!.chooseLocalWorkspace()),
    disable: () => change(() => desktop!.disableLocalWorkspace()),
    setMode: (mode: LocalPermissionMode) => change(() => desktop!.setLocalPermission(conversationId, mode)),
    respond: (id: string, decision: "deny" | "once" | "conversation") => change(() => desktop!.respondLocalApproval(conversationId!, id, decision)),
  };
}
export type DesktopWorkspaceControl = ReturnType<typeof useDesktopWorkspace>;
