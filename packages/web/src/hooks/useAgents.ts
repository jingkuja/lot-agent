import { useState, useEffect, useCallback } from "react";
import { api, type Agent } from "../api/client.js";

export interface UseAgents {
  agents: Agent[];
  loading: boolean;
  refresh: () => Promise<void>;

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

  return { agents, loading, refresh };
}
