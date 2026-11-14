import type { PosterFields, PosterStyle, PosterTemplate } from "@lot-agent/core/poster";
import { DesktopWorkspace, DesktopWorkspaceBar, DesktopApprovalCards } from "./DesktopWorkspace.js";
import { useDesktopWorkspace } from "../hooks/useDesktopWorkspace.js";
import { useI18n } from "../i18n/index.js";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MarketingVideoStudio } from "../modules/marketing-video/MarketingVideoStudio.js";
import { DigitalPresenterStudio } from "../modules/digital-presenter/DigitalPresenterStudio.js";
import { GenerationCard } from "./GenerationCard.js";
import { ImageComposeDialog, type ComposeImagesHandler } from "./ImageComposeDialog.js";
import type { ComposeLayout, ExportPreset, RedoRequest } from "../lib/image-settings.js";
import { MessageBubble } from "./MessageBubble.js";
import { InputBox, type InputBoxHandle, type InputMode } from "./InputBox.js";
import type { ImageSettings } from "./MediaSettings.js";
import { TypingDots } from "./TypingDots.js";
import { LandscapeBackdrop } from "./LandscapeBackdrop.js";
import type { DisplayMessage } from "../hooks/useChat.js";
import type { GenerationSettings } from "../hooks/chat-reducer.js";
import type {
  Agent, CatalogModel, ExportPosterHandler, KnowledgeBaseRef, PreviewPosterHandler, RestorePosterHandler,
} from "../api/client.js";
import { INTERACTIVE_TOOL_NAMES, failedInteractiveNames } from "../lib/interactive-tools.js";

const miniProgramCode = new URL("../assets/mini-program-code.jpg", import.meta.url).href;

interface ChatPanelProps {
  readOnly?: boolean;
  onDraftChange?: (hasDraft: boolean) => void;
  attachment?: { id: string; file: File };
  onAttachmentConsumed?: () => void;
  onManageKnowledge?: () => void;
  messages: DisplayMessage[];
  imageDraftRevision?: number;
  onSend: NonNullable<React.ComponentProps<typeof InputBox>["onSend"]>;
  onStop: (taskId?: string) => void;
  isStreaming: boolean;
  activeConversationId: string | null;
  onNewVideo?: () => void;
  videoPublication?: unknown;
  onRegenerate?: () => void;
  /** Called when an assistant reply is clicked, to open the preview. */
  onSelectForPreview?: (content: string) => void;
  /** Current agent (for the empty-state hero). */
  agent?: Agent | null;
  /** Product-specific actions rendered directly above the input box. */
  inputAbove?: React.ReactNode;
  /** Current user's name (for the empty-state greeting). */
  userName?: string;
  userId?: string;
  /** Per-user model catalog (llm/image/video) for the model picker. */
  modelCatalog?: { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] };
  /** Currently selected model id for this conversation (null = agent default). */
  selectedModel?: string | null;
  onModelChange?: (id: string) => void;
  /** Retry the download of a generation left in "下载失败". */
  onRedownloadGeneration?: (messageId: string, mediaType: "image" | "video") => void;
  onComposeGeneration?: (messageId: string, layout: ComposeLayout, gap: boolean) => Promise<string | undefined>;
  /** 图片合成 from the composer: join images picked from this conversation and 个人素材; resolves to an error text. */
  onComposeImages?: ComposeImagesHandler;
  onRedoGeneration?: (messageId: string, request: RedoRequest) => Promise<string | undefined>;
  onExportGeneration?: (messageId: string, preset: ExportPreset, names: string[], compositeNames: string[]) => Promise<string | undefined>;
  /** 真实字体: change the wording of one typeset image; resolves to an error text. */
  onEditPoster?: (
    messageId: string, index: number, fields: PosterFields, template: PosterTemplate, style?: PosterStyle,
    titleOptions?: { titleLines?: string[]; manualTitleLines?: boolean },
  ) => Promise<string | undefined>;
  onPreviewPoster?: PreviewPosterHandler;
  onRestorePoster?: RestorePosterHandler;
  onExportPoster?: ExportPosterHandler;
  onWhiteBackground?: (messageId: string, index: number, restore: boolean) => Promise<string | undefined>;
  /** Image-to-image from a generated image with its own settings (the composer's for older messages). */
  onEditImage?: (prompt: string, imageUrl: string, settings?: ImageSettings) => void;
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
  const { t, enabled: international } = useI18n();
  const miniProgramDialog = useRef<HTMLDialogElement>(null);
  const miniProgramTitleId = useId();

  if (international) return null;

  return (
    <>
      <div className="input-branding">
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
  const { t, enabled, modelName } = useI18n();
  return (
    <div className="input-seedance-hint" role="note">
      <span className="input-seedance-hint-icon" aria-hidden>⚠</span>
      <div className="input-seedance-hint-body">
        <strong>{enabled ? modelName("doubao-seedance-2-5") : "Seedance 2.5"}</strong>
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
  readOnly,
  attachment, onAttachmentConsumed, onManageKnowledge,
  activeConversationId, onNewVideo, videoPublication,
  messages,
  onSend,
  imageDraftRevision,
  onStop,
  isStreaming,
  onRegenerate,
  onSelectForPreview,
  agent,
  inputAbove,
  onDraftChange,
  userName, userId,
  modelCatalog,
  selectedModel,
  onModelChange,
  onRedownloadGeneration,
  onComposeGeneration,
  onComposeImages,
  onRedoGeneration,
  onExportGeneration,
  onEditPoster,
  onPreviewPoster,
  onRestorePoster,
  onExportPoster,
  onWhiteBackground,
  onEditImage,
  knowledgeBases,
  onKnowledgeBasesChange,
  emptyDashboard,
}: ChatPanelProps) {
  const { t } = useI18n();
  const desktopControl = useDesktopWorkspace(activeConversationId, !readOnly && agent?.id === "general");
  const pendingApprovalId = desktopControl.state?.approvals[0]?.id;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<InputBoxHandle>(null);

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
  }, [messages, awaitingResponse, pendingApprovalId]);

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

  // Editing a generated image sends from its own dialog with that image's settings,
  // checked against the selected model the way the composer checks a send.
  const editImage = mode === "image" && !readOnly && onEditImage
    ? async (imageUrl: string, prompt: string, original?: GenerationSettings): Promise<string | void> => {
      if (isStreaming) return "当前有任务正在进行，请完成后再修改";
      const prepared = await inputRef.current?.prepareImageSend(original, imageUrl) ?? {};
      if (prepared.error) return prepared.error;
      onEditImage(prompt, imageUrl, prepared.settings);
    }
    : undefined;

  // 图片合成 lists this conversation's finished images (and their composites), newest first.
  const [composeOpen, setComposeOpen] = useState(false);
  const conversationImages = useMemo(() => [...new Set(messages.flatMap((message) => {
    const generation = message.generation;
    if (generation?.mediaType !== "image" || generation.status !== "completed") return [];
    const assets = (generation.assets ?? []).filter((asset) => asset.mime?.startsWith("image/")).map((asset) => asset.url);
    return [...assets, ...(generation.composites ?? []).map((item) => item.url)];
  }).reverse())], [messages]);
  const composeImages = mode === "image" && !readOnly && onComposeImages ? () => setComposeOpen(true) : undefined;

  const modelList =
    mode === "image"
      ? modelCatalog?.image
      : mode === "video"
        ? modelCatalog?.video
        : modelCatalog?.llm;

  const inputEl = readOnly ? <p className="feishu-transcript-hint">{t("飞书任务与结果会自动同步到此处。请在飞书私聊机器人发送任务，输入 /cancel 可取消任务。")}</p> : (
    <>
      {isEmpty && mode === "video" && <Seedance25Hint />}
      {inputAbove && <div className="input-switcher">{inputAbove}</div>}
      <DesktopWorkspaceBar disabled={isStreaming} control={desktopControl} />
      <InputBox
        key={mode === "image" ? imageDraftRevision : undefined}
        ref={inputRef}
        toolbarStart={<DesktopWorkspace key={activeConversationId ?? "new"} disabled={isStreaming} control={desktopControl} />}
        onDraftChange={onDraftChange}
        attachment={attachment}
        onAttachmentConsumed={onAttachmentConsumed}
        onManageKnowledge={onManageKnowledge}
        onSend={onSend}
        onStop={onStop}
        disabled={isStreaming}
        autoFocus={isEmpty}
        mode={mode}
        imageScenes={mode === "image"}
        imageCollapsible={mode === "image" && !isEmpty}
        placeholder={
          mode === "ppt" ? t("描述要制作的 PPT，可上传模版与内容文件") : mode === "contract" ? t("上传旧版与新版合同，我来找出条款与主体差异") : mode !== "default" ? t("请输入内容") : undefined
        }
        models={modelList ?? []}
        selectedModel={selectedModel ?? null}
        onModelChange={onModelChange}
        allowKnowledgeBase={agent?.id === "general"}
        knowledgeBases={knowledgeBases}
        onKnowledgeBasesChange={onKnowledgeBasesChange}
        onComposeImages={composeImages}
      />
      {composeOpen && onComposeImages && (
        <ImageComposeDialog conversationImages={conversationImages} onCompose={onComposeImages} onClose={() => setComposeOpen(false)} />
      )}
      <InputBranding />
    </>
  );

  if (agent?.id === "marketing_video") {
    return <MarketingVideoStudio key={activeConversationId ?? "new"} ownerId={userId}
      onDraftChange={onDraftChange} onNewVideo={onNewVideo} busy={isStreaming} hasMessages={!isEmpty} publication={videoPublication}>
      {messages.map((message) => message.generation
        ? <GenerationCard key={message.id} generation={message.generation} messageId={message.id}
          onCancelGeneration={onStop} onRedownload={onRedownloadGeneration} />
        : message.role === "user" ? <details className="mv-script-review" key={message.id}><summary>{t("查看生成要求")}</summary><p>{message.content}</p></details> : null)}
    </MarketingVideoStudio>;
  }

  // Presenter videos are durable drafts with their own jobs, never chat messages.
  if (agent?.id === "digital_presenter") return <DigitalPresenterStudio key={userId ?? "anonymous"} ownerId={userId} onDraftChange={onDraftChange} />;

  const emptyGreeting = <>
    <p className="chat-empty-greeting">
      {t(timeGreeting())}
      {userName ? `，${userName}` : ""}
    </p>
    <h1 className="chat-empty-title">{t(agent?.name) ?? t("借势智算")}</h1>
    {agent?.description && <p className="chat-empty-desc">{t(agent.description)}</p>}
  </>;
  const emptyImage = isEmpty && mode === "image";
  // Keep the same input mounted through the first image submission.
  if (isEmpty && !emptyImage) {
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
        <LandscapeBackdrop className="chat-empty-landscape" />
        <div className="chat-empty-hero">
          {emptyGreeting}
          <div className="input-area input-area--centered">{inputEl}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={emptyImage ? "chat-panel chat-panel--empty" : "chat-panel"}>
      {emptyImage && <LandscapeBackdrop className="chat-empty-landscape" />}
      {!emptyImage && <div className="chat-messages">
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
              onQuickReply={isStreaming || readOnly ? undefined : (text) => { void onSend(text, []); }}
              askAnswer={askAnswer}
              askInteractive={hasInteractive && askAnswer === undefined && !isStreaming}
              failedToolNames={failedTools}
              onRedownloadGeneration={onRedownloadGeneration}
              onComposeGeneration={readOnly ? undefined : onComposeGeneration}
              onRedoGeneration={readOnly ? undefined : onRedoGeneration}
              onExportGeneration={onExportGeneration}
              onEditPoster={readOnly ? undefined : onEditPoster}
              onPreviewPoster={readOnly ? undefined : onPreviewPoster}
              onRestorePoster={readOnly ? undefined : onRestorePoster}
              onExportPoster={onExportPoster}
              onWhiteBackground={readOnly ? undefined : onWhiteBackground}
              onEditImage={editImage}
              onCancelGeneration={onStop}
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
        <DesktopApprovalCards control={desktopControl} />
        <div ref={messagesEndRef} />
      </div>}
      <div className={emptyImage ? "chat-empty-hero" : "chat-composer"}>
        {emptyImage && emptyGreeting}
        <div className={`input-area${emptyImage ? " input-area--centered" : ""}`}>{inputEl}</div>
      </div>
    </div>
  );
}
