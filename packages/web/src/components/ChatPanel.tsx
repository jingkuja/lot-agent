import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble.js";
import { InputBox } from "./InputBox.js";
import type { DisplayMessage } from "../hooks/useChat.js";
import type { Agent } from "../api/client.js";

interface ChatPanelProps {
  messages: DisplayMessage[];
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  activeConversationId: string | null;
  onRegenerate?: () => void;
  /** Bottom-left content of the input box (agent switcher). */
  inputLeftSlot?: React.ReactNode;
  /** Called when an assistant reply is clicked, to open the preview. */
  onSelectForPreview?: (content: string) => void;
  /** Current agent (for the empty-state hero). */
  agent?: Agent | null;
}

export function ChatPanel({
  messages,
  onSend,
  onStop,
  isStreaming,
  onRegenerate,
  inputLeftSlot,
  onSelectForPreview,
  agent,
}: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Only show regenerate on the last completed assistant message
  const lastAssistantIdx = [...messages]
    .reverse()
    .findIndex((m) => m.role === "assistant" && !m.isStreaming);
  const lastAssistantId =
    lastAssistantIdx >= 0 ? [...messages].reverse()[lastAssistantIdx].id : null;

  const isEmpty = messages.length === 0;

  const inputEl = (
    <InputBox
      onSend={onSend}
      onStop={onStop}
      disabled={isStreaming}
      leftSlot={inputLeftSlot}
      autoFocus={isEmpty}
    />
  );

  // Empty conversation: center the (enlarged) input in the page.
  if (isEmpty) {
    return (
      <div className="chat-panel chat-panel--empty">
        <div className="chat-empty-hero">
          <div className="chat-empty-logo" aria-hidden />
          <h1 className="chat-empty-title">{agent?.name ?? "Lot Agent"}</h1>
          {agent?.description && (
            <p className="chat-empty-desc">{agent.description}</p>
          )}
          <div className="input-area input-area--centered">{inputEl}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onRegenerate={
              msg.id === lastAssistantId && !isStreaming ? onRegenerate : undefined
            }
            onSelectForPreview={onSelectForPreview}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="input-area">{inputEl}</div>
    </div>
  );
}
