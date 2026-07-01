import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Conversation } from "../api/client.js";

const PAGE_SIZE = 20;

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); // start as true
  const [loadingMore, setLoadingMore] = useState(false);
  // nextCursor (id of the last loaded row) for the next keyset page; null = end.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const hasMore = nextCursor !== null;
  const initialized = useRef(false);

  // Refresh from the top. Keeps however many pages are already loaded (so a
  // post-stream refresh doesn't collapse the list back to one page) by
  // refetching max(loaded, PAGE_SIZE) rows in a single keyset page.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const count = Math.min(Math.max(conversations.length, PAGE_SIZE), 100);
      const { items, nextCursor } = await api.listConversations(count);
      setConversations(items);
      setNextCursor(nextCursor);
    } finally {
      setLoading(false);
    }
  }, [conversations.length]);

  // Append the next keyset page, de-duping by id (the list reorders live, so a
  // page can still overlap with rows already held).
  const loadMore = useCallback(async () => {
    if (loadingMore || nextCursor === null) return;
    setLoadingMore(true);
    try {
      const { items, nextCursor: next } = await api.listConversations(
        PAGE_SIZE,
        nextCursor
      );
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...items.filter((c) => !seen.has(c.id))];
      });
      setNextCursor(next);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      // First load: exactly one page.
      setLoading(true);
      api
        .listConversations(PAGE_SIZE)
        .then(({ items, nextCursor }) => {
          setConversations(items);
          setNextCursor(nextCursor);
        })
        .finally(() => setLoading(false));
    }
  }, []);

  const create = useCallback(async () => {
    const conv = await api.createConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    return conv;
  }, []);

  // Optimistically surface a just-created conversation in the sidebar. The
  // server list filters out 0-message conversations, so a brand-new chat would
  // otherwise be invisible until its first reply persists; this bridges the gap
  // (a later refresh reconciles it, or drops it if the send never lands).
  const addLocal = useCallback((conv: Conversation) => {
    setConversations((prev) =>
      prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]
    );
  }, []);

  // In-place title update (e.g. live auto-generated title from the stream),
  // without refetching the whole list.
  const updateTitle = useCallback((id: string, title: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    );
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await api.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) setActiveId(null);
    },
    [activeId]
  );

  return {
    conversations,
    activeId,
    setActiveId,
    create,
    addLocal,
    remove,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    refresh,
    updateTitle,
  };
}
