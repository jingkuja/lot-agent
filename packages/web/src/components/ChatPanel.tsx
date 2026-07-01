import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble.js";
import { InputBox, type InputMode } from "./InputBox.js";
import type { ImageSettings, VideoSettings } from "./MediaSettings.js";
import { TypingDots } from "./TypingDots.js";
import type { DisplayMessage } from "../hooks/useChat.js";
import type { Agent } from "../api/client.js";

interface ChatPanelProps {
  messages: DisplayMessage[];
  onSend: (content: string, files: File[], settings?: ImageSettings | VideoSettings) => void;
  onStop: () => void;
  isStreaming: boolean;
  activeConversationId: string | null;
  onRegenerate?: () => void;
  /** Content rendered directly above the input box (agent switcher). */
  inputAbove?: React.ReactNode;
  /** Called when an assistant reply is clicked, to open the preview. */
  onSelectForPreview?: (content: string) => void;
  /** Current agent (for the empty-state hero). */
  agent?: Agent | null;
  /** Current user's name (for the empty-state greeting). */
  userName?: string;
}

/** 按本地时间返回问候语：早上好 / 下午好 / 晚上好。 */
function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "早上好";
  if (h < 18) return "下午好";
  return "晚上好";
}

export function ChatPanel({
  messages,
  onSend,
  onStop,
  isStreaming,
  onRegenerate,
  inputAbove,
  onSelectForPreview,
  agent,
  userName,
}: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // While streaming, the assistant bubble only enters the list once its first
  // text/tool_call arrives. Until then (and in the gap after a tool result,
  // before the model's next turn) the latest message is the user's prompt or a
  // tool result — show a typing indicator so the user knows the request was
  // accepted and a reply is on the way.
  const last = messages[messages.length - 1];
  const awaitingResponse =
    isStreaming && (!last || last.role === "user" || last.role === "tool");

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, awaitingResponse]);

  // Only show regenerate on the last completed assistant message
  const lastAssistantIdx = [...messages]
    .reverse()
    .findIndex((m) => m.role === "assistant" && !m.isStreaming);
  const lastAssistantId =
    lastAssistantIdx >= 0 ? [...messages].reverse()[lastAssistantIdx].id : null;

  const isEmpty = messages.length === 0;
  const agentKind = agent?.type || agent?.id;
  const mode: InputMode =
    agentKind === "image" ? "image" : agentKind === "video" ? "video" : "default";

  const inputEl = (
    <>
      {inputAbove && <div className="input-switcher">{inputAbove}</div>}
      <InputBox
        onSend={onSend}
        onStop={onStop}
        disabled={isStreaming}
        autoFocus={isEmpty}
        mode={mode}
        placeholder={mode !== "default" ? "请输入内容" : undefined}
      />
    </>
  );

  // Empty conversation: center the (enlarged) input in the page.
  if (isEmpty) {
    return (
      <div className="chat-panel chat-panel--empty">
        <div className="chat-empty-hero">
          <p className="chat-empty-greeting">
            {timeGreeting()}
            {userName ? `，${userName}` : ""}
          </p>
          <h1 className="chat-empty-title">{agent?.name ?? "借势智算"}</h1>
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
        {awaitingResponse && (
          <div className="message-wrapper message-assistant">
            <div className="message-wrapper-inner">
              <TypingDots />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="input-area">{inputEl}</div>
    </div>
  );
}
