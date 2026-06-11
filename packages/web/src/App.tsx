import { useEffect, useCallback, useRef } from "react";
import { Sidebar } from "./components/Sidebar.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { StatusBar } from "./components/StatusBar.js";
import { useConversations } from "./hooks/useConversations.js";
import { useChat } from "./hooks/useChat.js";
import "./App.css";

export default function App() {
  const {
    conversations,
    activeId,
    setActiveId,
    create,
    remove,
    loading,
    refresh,
  } = useConversations();

  // When stream ends, wait for async title generation then refresh list
  const handleStreamEnd = useCallback(() => {
    setTimeout(() => refresh(), 1500);
  }, [refresh]);

  const { messages, send, stop, isStreaming, loadMessages, clear, regenerate } =
    useChat(activeId, handleStreamEnd);

  const didInit = useRef(false);

  // After initial load: pick the latest existing conversation, or create one
  useEffect(() => {
    if (loading || didInit.current) return;
    didInit.current = true;

    if (conversations.length > 0) {
      const latest = conversations[0];
      setActiveId(latest.id);
      loadMessages(latest.id);
    } else {
      create().then((conv) => {
        loadMessages(conv.id);
      });
    }
  }, [loading, conversations, setActiveId, create, loadMessages]);

  const handleSelect = useCallback(
    (id: string) => {
      setActiveId(id);
      clear();
      loadMessages(id);
    },
    [setActiveId, loadMessages, clear]
  );

  const handleCreate = useCallback(async () => {
    const conv = await create();
    clear();
    loadMessages(conv.id);
  }, [create, loadMessages, clear]);

  const handleDelete = useCallback(
    (id: string) => {
      remove(id);
      if (id === activeId) clear();
    },
    [remove, activeId, clear]
  );

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onDelete={handleDelete}
      />
      <div className="main-content">
        <ChatPanel
          messages={messages}
          onSend={send}
          onStop={stop}
          isStreaming={isStreaming}
          activeConversationId={activeId}
          onRegenerate={regenerate}
        />
        <StatusBar isStreaming={isStreaming} />
      </div>
    </div>
  );
}
