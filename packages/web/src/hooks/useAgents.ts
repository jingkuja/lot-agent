import { useState, useEffect, useCallback } from "react";
import { api, type Agent } from "../api/client.js";

export interface UseAgents {
  agents: Agent[];
  installed: Agent[];
  loading: boolean;
  refresh: () => Promise<void>;
  install: (id: string) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  promote: (id: string) => Promise<void>;
}

export function useAgents(enabled: boolean): UseAgents {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setAgents(await api.listAgents());
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
    else setAgents([]);
  }, [enabled, refresh]);

  const install = useCallback(async (id: string) => { await api.installAgent(id); await refresh(); }, [refresh]);
  const uninstall = useCallback(async (id: string) => { await api.uninstallAgent(id); await refresh(); }, [refresh]);
  const promote = useCallback(async (id: string) => { await api.promoteAgent(id); await refresh(); }, [refresh]);

  return { agents, installed: agents.filter((a) => a.installed), loading, refresh, install, uninstall, promote };
}
