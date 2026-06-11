import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Conversation } from "../api/client.js";

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); // start as true
  const initialized = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listConversations();
      setConversations(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      refresh();
    }
  }, [refresh]);

  const create = useCallback(async () => {
    const conv = await api.createConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    return conv;
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await api.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) setActiveId(null);
    },
    [activeId]
  );

  return { conversations, activeId, setActiveId, create, remove, loading, refresh };
}
