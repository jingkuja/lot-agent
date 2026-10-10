import { useI18n } from "../i18n/index.js";
import { useEffect, useId, useRef, useState } from "react";
import { MessageBubble } from "./MessageBubble.js";
import { InputBox, type InputMode } from "./InputBox.js";
import type { ImageSettings, VideoSettings } from "./MediaSettings.js";
import { TypingDots } from "./TypingDots.js";
import type { DisplayMessage } from "../hooks/useChat.js";
import type { Agent, CatalogModel, KnowledgeBaseRef, PickedFile } from "../api/client.js";
import { INTERACTIVE_TOOL_NAMES, failedInteractiveNames } from "../lib/interactive-tools.js";

const miniProgramCode = new URL("../assets/mini-program-code.jpg", import.meta.url).href;

interface ChatPanelProps {
  onDraftChange?: (hasDraft: boolean) => void;
  attachment?: { id: string; file: File };
  onAttachmentConsumed?: () => void;
  onManageKnowledge?: () => void;
  messages: DisplayMessage[];
  onSend: (content: string, files: PickedFile[], settings?: ImageSettings | VideoSettings, knowledgeBases?: KnowledgeBaseRef[]) => void;
  onStop: () => void;
  isStreaming: boolean;
  activeConversationId: string | null;
  onRegenerate?: () => void;
  /** Called when an assistant reply is clicked, to open the preview. */
  onSelectForPreview?: (content: string) => void;
  /** Current agent (for the empty-state hero). */
  agent?: Agent | null;
  /** Product-specific actions rendered directly above the input box. */
  inputAbove?: React.ReactNode;
  /** Current user's name (for the empty-state greeting). */
  userName?: string;
  /** Per-user model catalog (llm/image/video) for the model picker. */
  modelCatalog?: { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] };
  /** Currently selected model id for this conversation (null = agent default). */
  selectedModel?: string | null;
  onModelChange?: (id: string) => void;
  /** Retry the download of a generation left in "下载失败". */
  onRedownloadGeneration?: (messageId: string, mediaType: "image" | "video") => void;
  knowledgeBases?: KnowledgeBaseRef[];
  onKnowledgeBasesChange?: (items: KnowledgeBaseRef[]) => void;
  /** Product-specific content replacing the generic empty-state hero. */
  emptyDashboard?: React.ReactNode;
}

/** 按本地时间返回问候语：早上好 / 下午好 / 晚上好。 */
function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "早上好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function InputBranding() {
  const { t } = useI18n();
  const [copyStatus, setCopyStatus] = useState("");
  const miniProgramDialog = useRef<HTMLDialogElement>(null);
  const miniProgramTitleId = useId();

  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(""), 2500);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText("https://wetok.ai");
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败，请选中地址手动复制");
    }
  }

  return (
    <>
      <div className="input-branding">
        <a href="https://wetok.ai" target="_blank" rel="noopener noreferrer">{t("灵渠AI")}</a>
        <button type="button" onClick={copyAddress} title={t("复制网址")} aria-label={t("复制网址 https://wetok.ai")}>
          https://wetok.ai
        </button>
        <button
          type="button"
          className="input-mini-program"
          onClick={() => miniProgramDialog.current?.showModal()}
          aria-haspopup="dialog"
          title={t("查看小程序码")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m8 0h4a1 1 0 0 0 1-1v-4" />
            <rect x="8" y="8" width="8" height="8" rx="2" />
          </svg>
          {t("小程序")}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
        <span className="input-branding-status" role="status">{t(copyStatus)}</span>
      </div>
      <dialog
        ref={miniProgramDialog}
        className="mini-program-dialog"
        aria-labelledby={miniProgramTitleId}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
            event.currentTarget.close();
          }
        }}
      >
        <button type="button" className="mini-program-close" onClick={() => miniProgramDialog.current?.close()} aria-label={t("关闭")} autoFocus>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
        <h2 id={miniProgramTitleId}>{t("灵渠claw小程序")}</h2>
        <img src={miniProgramCode} alt={t("灵渠claw小程序码")} width="258" height="258" />
        <p>{t("微信扫一扫，打开小程序")}</p>
      </dialog>
    </>
  );
}

function Seedance25Hint() {
  const { t } = useI18n();
  return (
    <div className="input-seedance-hint" role="note">
      <span className="input-seedance-hint-icon" aria-hidden>⚠</span>
      <div className="input-seedance-hint-body">
        <strong>Seedance 2.5</strong>
        <ul>
          <li>
            {t("使用参考图 / 参考视频 / 参考音频时，提示词必须按上传顺序显式写出")}{" "}
            <code>@Image1</code>、<code>@Video1</code>、<code>@Audio1</code>
            {t("，否则参考视频/音频会被静默降级为「风格暗示」甚至忽略。")}</li>
          <li>
            {t("若参考图或参考视频涉及真人，必须先到火山方舟官方完成真人认证；不支持直接使用含真人人脸的公网 URL。")}</li>
          <li>{t("首帧图、尾帧图比例需要和生成视频比例一致。")}</li>
          <li>
            {t("提示词案例：")}<code>@Video1</code> {t("中增加一条鱼从湖面上跳出来")}</li>
        </ul>
      </div>
    </div>
  );
}

export function ChatPanel({
  attachment, onAttachmentConsumed, onManageKnowledge,
  messages,
  onSend,
  onStop,
  isStreaming,
  onRegenerate,
  onSelectForPreview,
  agent,
  inputAbove,
  onDraftChange,
  userName,
  modelCatalog,
  selectedModel,
  onModelChange,
  onRedownloadGeneration,
  knowledgeBases,
  onKnowledgeBasesChange,
  emptyDashboard,
}: ChatPanelProps) {
  const { t } = useI18n();
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
      {isEmpty && mode === "video" && <Seedance25Hint />}
      {inputAbove && <div className="input-switcher">{inputAbove}</div>}
      <InputBox
        onDraftChange={onDraftChange}
        attachment={attachment}
        onAttachmentConsumed={onAttachmentConsumed}
        onManageKnowledge={onManageKnowledge}
        onSend={onSend}
        onStop={onStop}
        disabled={isStreaming}
        autoFocus={isEmpty}
        mode={mode}
        placeholder={
          mode === "ppt" ? t("描述要制作的 PPT，可上传模版与内容文件") : mode === "contract" ? t("上传旧版与新版合同，我来找出条款与主体差异") : mode !== "default" ? t("请输入内容") : undefined
        }
        models={modelList ?? []}
        selectedModel={selectedModel ?? null}
        onModelChange={onModelChange}
        allowKnowledgeBase={agent?.id === "general"}
        knowledgeBases={knowledgeBases}
        onKnowledgeBasesChange={onKnowledgeBasesChange}
      />
      <InputBranding />
    </>
  );

  // Empty conversation: center the (enlarged) input in the page.
  if (isEmpty) {
    if (emptyDashboard) {
      return (
        <div className="chat-panel chat-panel--empty chat-panel--digital-home">
          <div className="digital-home-scroll">
            {emptyDashboard}
            <div className="input-area input-area--digital-home">{inputEl}</div>
          </div>
        </div>
      );
    }
    return (
      <div className="chat-panel chat-panel--empty">
        <div className="chat-empty-hero">
          <p className="chat-empty-greeting">
            {t(timeGreeting())}
            {userName ? `，${userName}` : ""}
          </p>
          <h1 className="chat-empty-title">{t(agent?.name) ?? t("借势智算")}</h1>
          {agent?.description && (
            <p className="chat-empty-desc">{t(agent.description)}</p>
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
          const hasInteractive =
            msg.role === "assistant" &&
            !!msg.toolCalls?.some((tc) => INTERACTIVE_TOOL_NAMES.includes(tc.name));
          const askAnswer = hasInteractive
            ? messages.slice(i + 1).find((m) => m.role === "user")?.content
            : undefined;
          // Interactive calls rejected by the tool itself (e.g. propose_outline
          // failing layout validation before the agent retries) must not render
          // as a second live confirmation card.
          const failedTools = hasInteractive ? failedInteractiveNames(messages, i) : [];
          return (
            <MessageBubble
              key={msg.id}
              message={msg}
              onRegenerate={
                msg.id === lastAssistantId && !isStreaming ? onRegenerate : undefined
              }
              onSelectForPreview={onSelectForPreview}
              onQuickReply={isStreaming ? undefined : (text) => onSend(text, [])}
              askAnswer={askAnswer}
              askInteractive={hasInteractive && askAnswer === undefined && !isStreaming}
              failedToolNames={failedTools}
              onRedownloadGeneration={onRedownloadGeneration}
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
