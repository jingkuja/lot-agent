import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble.js";
import { InputBox, type InputMode } from "./InputBox.js";
import type { ImageSettings, VideoSettings } from "./MediaSettings.js";
import { TypingDots } from "./TypingDots.js";
import type { DisplayMessage } from "../hooks/useChat.js";
import type { Agent, CatalogModel, PickedFile } from "../api/client.js";

interface ChatPanelProps {
  messages: DisplayMessage[];
  onSend: (content: string, files: PickedFile[], settings?: ImageSettings | VideoSettings) => void;
  onStop: () => void;
  isStreaming: boolean;
  activeConversationId: string | null;
  onRegenerate?: () => void;
  /** Called when an assistant reply is clicked, to open the preview. */
  onSelectForPreview?: (content: string) => void;
  /** Current agent (for the empty-state hero). */
  agent?: Agent | null;
  /** Content rendered directly above the input box (agent switcher). */
  inputAbove?: React.ReactNode;
  /** Current user's name (for the empty-state greeting). */
  userName?: string;
  /** Per-user model catalog (llm/image/video) for the model picker. */
  modelCatalog?: { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] };
  /** Currently selected model id for this conversation (null = agent default). */
  selectedModel?: string | null;
  onModelChange?: (id: string) => void;
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
  onSelectForPreview,
  agent,
  inputAbove,
  userName,
  modelCatalog,
  selectedModel,
  onModelChange,
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
    agentKind === "image"
      ? "image"
      : agentKind === "video"
        ? "video"
        : agentKind === "ppt"
          ? "ppt"
          : agentKind === "contract"
            ? "contract"
            : "default";

  const modelList =
    mode === "image"
      ? modelCatalog?.image
      : mode === "video"
        ? modelCatalog?.video
        : modelCatalog?.llm;

  const inputEl = (
    <>
      {inputAbove && <div className="input-switcher">{inputAbove}</div>}
      <InputBox
        onSend={onSend}
        onStop={onStop}
        disabled={isStreaming}
        autoFocus={isEmpty}
        mode={mode}
        placeholder={
          mode === "ppt"
            ? "描述要制作的 PPT，可上传模版与内容文件"
            : mode === "contract"
              ? "上传旧版与新版合同，我来找出条款与主体差异"
              : mode !== "default"
                ? "请输入内容"
                : undefined
        }
        models={modelList ?? []}
        selectedModel={selectedModel ?? null}
        onModelChange={onModelChange}
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
        {messages.map((msg, i) => {
          const hasAsk =
            msg.role === "assistant" &&
            !!msg.toolCalls?.some((tc) => tc.name === "ask_user");
          const askAnswer = hasAsk
            ? messages.slice(i + 1).find((m) => m.role === "user")?.content
            : undefined;
          return (
            <MessageBubble
              key={msg.id}
              message={msg}
              onRegenerate={
                msg.id === lastAssistantId && !isStreaming ? onRegenerate : undefined
              }
              onSelectForPreview={onSelectForPreview}
              onQuickReply={(text) => onSend(text, [])}
              askAnswer={askAnswer}
              askInteractive={hasAsk && askAnswer === undefined && !isStreaming}
            />
          );
        })}
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
