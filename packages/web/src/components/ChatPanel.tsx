import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble.js";
import { InputBox } from "./InputBox.js";
import type { DisplayMessage } from "../hooks/useChat.js";

interface ChatPanelProps {
  messages: DisplayMessage[];
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  activeConversationId: string | null;
  onRegenerate?: () => void;
}

export function ChatPanel({
  messages,
  onSend,
  onStop,
  isStreaming,
  onRegenerate,
}: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Only show regenerate on the last assistant message
  const lastAssistantIdx = [...messages]
    .reverse()
    .findIndex((m) => m.role === "assistant" && !m.isStreaming);
  const lastAssistantId =
    lastAssistantIdx >= 0
      ? [...messages].reverse()[lastAssistantIdx].id
      : null;

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <h1>Lot Agent</h1>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onRegenerate={
              msg.id === lastAssistantId && !isStreaming
                ? onRegenerate
                : undefined
            }
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="input-area">
        <InputBox onSend={onSend} onStop={onStop} disabled={isStreaming} />
      </div>
    </div>
  );
}
