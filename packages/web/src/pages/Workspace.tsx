import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { Sidebar } from "../components/Sidebar.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { StatusBar } from "../components/StatusBar.js";
import { PreviewPanel } from "../components/PreviewPanel.js";
import { ArtifactGallery, type Artifact } from "../components/ArtifactGallery.js";
import { AgentSwitcher } from "../components/AgentSwitcher.js";
import { useConversations } from "../hooks/useConversations.js";
import { useChat } from "../hooks/useChat.js";
import { api, type Agent, type User } from "../api/client.js";

interface WorkspaceProps {
  agents: Agent[];
  user: User;
  onLogout: () => void;
}

export function Workspace({ agents, user, onLogout }: WorkspaceProps) {
  // General agent is always first in the switcher.
  const orderedAgents = useMemo(() => {
    const general = agents.find((a) => a.type === "general" || a.id === "general");
    if (!general) return agents;
    return [general, ...agents.filter((a) => a !== general)];
  }, [agents]);

  const defaultAgentId = orderedAgents[0]?.id ?? "general";
  const [activeAgentId, setActiveAgentId] = useState(defaultAgentId);
  const activeAgent = orderedAgents.find((a) => a.id === activeAgentId) ?? null;

  const { conversations, activeId, setActiveId, remove, loading, refresh } =
    useConversations();
  const [artifacts] = useState<Artifact[]>([]);
  // Preview is hidden by default; set to a string when a reply is clicked.
  const [previewContent, setPreviewContent] = useState<string | null>(null);

  const handleStreamEnd = useCallback(() => {
    setTimeout(() => refresh(), 1500);
  }, [refresh]);

  const { messages, send, stop, isStreaming, loadMessages, clear, regenerate } =
    useChat(activeId, handleStreamEnd);

  // Reset preview when the conversation changes.
  const prevActiveId = useRef<string | null>(null);
  useEffect(() => {
    if (activeId !== prevActiveId.current) {
      prevActiveId.current = activeId;
      setPreviewContent(null);
    }
  }, [activeId]);

  // Start a fresh conversation bound to a given agent (centers the empty input).
  const startConversationForAgent = useCallback(
    async (agentId: string) => {
      const conv = await api.createConversation(undefined, agentId);
      setActiveAgentId(agentId);
      setActiveId(conv.id);
      clear();
      loadMessages(conv.id);
      setPreviewContent(null);
      refresh();
    },
    [setActiveId, loadMessages, clear, refresh]
  );

  // On mount: enter the general agent directly with an empty conversation.
  const didInit = useRef(false);
  useEffect(() => {
    if (loading || didInit.current) return;
    didInit.current = true;
    startConversationForAgent(defaultAgentId);
  }, [loading, defaultAgentId, startConversationForAgent]);

  const handleSwitchAgent = useCallback(
    (agentId: string) => {
      // Re-clicking the active agent on an empty conversation is a no-op.
      if (agentId === activeAgentId && messages.length === 0) return;
      startConversationForAgent(agentId);
    },
    [activeAgentId, messages.length, startConversationForAgent]
  );

  const handleSelect = useCallback(
    (id: string) => {
      setActiveId(id);
      clear();
      loadMessages(id);
      setPreviewContent(null);
    },
    [setActiveId, loadMessages, clear]
  );

  const handleCreate = useCallback(() => {
    // New chat keeps the current agent.
    startConversationForAgent(activeAgentId);
  }, [startConversationForAgent, activeAgentId]);

  const handleDelete = useCallback(
    (id: string) => {
      remove(id);
      if (id === activeId) clear();
    },
    [remove, activeId, clear]
  );

  const switcher = (
    <AgentSwitcher
      agents={orderedAgents}
      activeId={activeAgentId}
      onSwitch={handleSwitchAgent}
      disabled={isStreaming}
    />
  );

  return (
    <div className="workspace">
      <div className="workspace-sidebar">
        <div className="workspace-back">
          <span className="workspace-brand">Lot Agent</span>
          {activeAgent && (
            <span className="workspace-agent-label">{activeAgent.name}</span>
          )}
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
            onSend={send}
            onStop={stop}
            isStreaming={isStreaming}
            activeConversationId={activeId}
            onRegenerate={regenerate}
            inputLeftSlot={switcher}
            onSelectForPreview={setPreviewContent}
            agent={activeAgent}
          />
          <StatusBar isStreaming={isStreaming} user={user} onLogout={onLogout} />
        </div>

        {previewContent !== null && (
          <div className="workspace-right">
            <PreviewPanel
              content={previewContent}
              onClose={() => setPreviewContent(null)}
            />
            <ArtifactGallery artifacts={artifacts} />
          </div>
        )}
      </div>
    </div>
  );
}
