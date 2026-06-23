import { useEffect, useCallback, useRef, useState } from "react";
import { Sidebar } from "../components/Sidebar.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { StatusBar } from "../components/StatusBar.js";
import { PreviewPanel } from "../components/PreviewPanel.js";
import { ArtifactGallery, type Artifact } from "../components/ArtifactGallery.js";
import { useConversations } from "../hooks/useConversations.js";
import { useChat } from "../hooks/useChat.js";
import { api, type Agent, type User } from "../api/client.js";

interface WorkspaceProps {
  initialAgent: Agent;
  user: User;
  onBack: () => void;
  onLogout: () => void;
}

export function Workspace({ initialAgent, user, onBack, onLogout }: WorkspaceProps) {
  const {
    conversations,
    activeId,
    setActiveId,
    create,
    remove,
    loading,
    refresh,
  } = useConversations();

  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  const handleStreamEnd = useCallback(() => {
    setTimeout(() => refresh(), 1500);
  }, [refresh]);

  const { messages, send, stop, isStreaming, loadMessages, clear, regenerate } =
    useChat(activeId, handleStreamEnd);

  // Collect artifact events
  const handleSend = useCallback(
    (content: string) => {
      // We intercept artifact events via a wrapper around the raw sendMessage
      // useChat's streamMessage will call api.sendMessage internally, so we
      // hook into it via a patched version – but since useChat is encapsulated,
      // the simplest approach is to subscribe to artifact events on stream done.
      // For now artifacts come from the SSE stream; wire them when useChat exposes them.
      send(content);
    },
    [send]
  );

  // Reset artifacts when switching conversations
  const prevActiveId = useRef<string | null>(null);
  useEffect(() => {
    if (activeId !== prevActiveId.current) {
      prevActiveId.current = activeId;
      setArtifacts([]);
    }
  }, [activeId]);

  const didInit = useRef(false);

  // Create a conversation for the selected agent on mount
  useEffect(() => {
    if (loading || didInit.current) return;
    didInit.current = true;

    api.createConversation(undefined, initialAgent.id).then((conv) => {
      setActiveId(conv.id);
      loadMessages(conv.id);
      refresh();
    });
  }, [loading, initialAgent.id, setActiveId, loadMessages, refresh]);

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

  // Get the last assistant message text for preview
  const lastAssistantContent =
    [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";

  return (
    <div className="workspace">
      <div className="workspace-sidebar">
        <div className="workspace-back">
          <button className="btn-back" onClick={onBack}>
            ← 首页
          </button>
          <span className="workspace-agent-label">{initialAgent.name}</span>
        </div>
        <Sidebar
          conversations={conversations}
          activeId={activeId}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onDelete={handleDelete}
        />
      </div>

      <div className="workspace-main">
        <div className="workspace-chat">
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            onStop={stop}
            isStreaming={isStreaming}
            activeConversationId={activeId}
            onRegenerate={regenerate}
          />
          <StatusBar isStreaming={isStreaming} user={user} onLogout={onLogout} />
        </div>

        <div className="workspace-right">
          <PreviewPanel content={lastAssistantContent} />
          <ArtifactGallery artifacts={artifacts} />
        </div>
      </div>
    </div>
  );
}
