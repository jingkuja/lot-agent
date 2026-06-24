import React, { useState, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api/client.js";
import { TypingDots } from "./TypingDots.js";
import type { DisplayMessage } from "../hooks/useChat.js";

interface MessageBubbleProps {
  message: DisplayMessage;
  onRegenerate?: () => void;
  /** Click an assistant reply to open it in the preview panel. */
  onSelectForPreview?: (content: string) => void;
}

export function MessageBubble({ message, onRegenerate, onSelectForPreview }: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="message-wrapper message-user">
        <div className="message-wrapper-inner">
          {message.content && <div className="message-content">{message.content}</div>}
          {message.attachments && message.attachments.length > 0 && (
            <div className="message-attachments">
              {message.attachments.map((a, i) => (
                <a
                  className="attachment-chip"
                  key={i}
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {a.kind === "image" ? (
                    <img className="attachment-thumb" src={a.url} alt={a.filename} />
                  ) : (
                    <span className="attachment-doc-icon" aria-hidden>📄</span>
                  )}
                  <span className="attachment-name" title={a.filename}>{a.filename}</span>
                </a>
              ))}
            </div>
          )}
          <div className="message-actions-row message-actions-right">
            <MessageActions content={message.content} role="user" />
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    // Tool result message — rendered as a collapsible card
    return (
      <div className="message-wrapper message-tool">
        <div className="message-wrapper-inner">
          <CollapsibleToolCard
            title={message.toolResult?.name ?? "tool"}
            type="result"
            isError={message.toolResult?.isError}
            defaultCollapsed={!!message.dbId}
          >
            <pre className="tool-output">
              {message.toolResult?.output ?? message.content}
            </pre>
          </CollapsibleToolCard>
        </div>
      </div>
    );
  }

  // Assistant message
  // A streaming message that already carries tool calls is in the
  // tool-execution phase (the model finished its text turn and we're waiting
  // for the tool result) — show a tool-running hint instead of a text caret.
  const executingTools = !!message.isStreaming && !!message.toolCalls?.length;
  return (
    <div className="message-wrapper message-assistant">
      <div className="message-wrapper-inner">
        {/* Tool call cards */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="tool-calls-section">
            {message.toolCalls.map((tc, i) => {
              const inputStr = JSON.stringify(tc.input, null, 2) ?? "";
              const hasInput =
                inputStr && inputStr !== "{}" && inputStr !== "null";
              return (
                <CollapsibleToolCard
                  key={i}
                  title={tc.name}
                  type="call"
                  defaultCollapsed={!!message.dbId}
                >
                  {hasInput && (
                    <pre className="tool-input">{inputStr}</pre>
                  )}
                </CollapsibleToolCard>
              );
            })}
          </div>
        )}

        {/* Message content — click to open in preview */}
        {(() => {
          const canPreview =
            !!onSelectForPreview && !!message.content && !message.isStreaming;
          return (
        <div
          className={`message-content markdown-body${canPreview ? " clickable" : ""}`}
          onClick={canPreview ? () => onSelectForPreview!(message.content) : undefined}
          title={canPreview ? "点击预览" : undefined}
        >
          {message.content ? (
            <>
              <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
              {message.isStreaming && !executingTools && (
                <span className="cursor-blink" />
              )}
            </>
          ) : message.isStreaming && !executingTools ? (
            <TypingDots />
          ) : (
            ""
          )}
        </div>
          );
        })()}

        {/* Tool execution hint — replaces the text caret while a tool runs */}
        {executingTools && (
          <div className="tool-running" role="status">
            <TypingDots />
            <span className="tool-running-label">
              正在执行工具 {message.toolCalls![message.toolCalls!.length - 1].name}…
            </span>
          </div>
        )}

        {/* Action buttons — skip intermediate tool-calling turns; those
            actions belong to the final answer, not a turn that ends in a tool
            call (keeps the call → reply → result sequence reading as one unit). */}
        {!message.isStreaming &&
          message.content &&
          !(message.toolCalls && message.toolCalls.length > 0) && (
          <MessageActions
            content={message.content}
            role="assistant"
            messageId={message.dbId}
            rating={message.rating}
            onRegenerate={onRegenerate}
          />
        )}
      </div>
    </div>
  );
}

// ── Collapsible Tool Card ──

function CollapsibleToolCard({
  title,
  type,
  isError,
  defaultCollapsed = false,
  children,
}: {
  title: string;
  type: "call" | "result";
  isError?: boolean;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const hasContent = React.Children.count(children) > 0;

  return (
    <div
      className={`tool-card ${type} ${isError ? "error" : ""} ${collapsed ? "collapsed" : ""}`}
    >
      <div
        className="tool-card-header clickable"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="tool-card-chevron">{collapsed ? "▶" : "▼"}</span>
        <span className="tool-card-icon">
          {type === "call" ? "⚙" : isError ? "✕" : "✓"}
        </span>
        <span className="tool-card-title">{title}</span>
        <span className="tool-card-type">
          {type === "call" ? "calling" : "result"}
        </span>
      </div>
      {!collapsed && hasContent && (
        <div className="tool-card-body">{children}</div>
      )}
    </div>
  );
}

// ── Action Buttons ──

interface MessageActionsProps {
  content: string;
  role: "user" | "assistant";
  messageId?: string;
  rating?: number | null;
  onRegenerate?: () => void;
}

function MessageActions({
  content,
  role,
  messageId,
  rating,
  onRegenerate,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [currentRating, setCurrentRating] = useState<number | null>(
    rating ?? null
  );
  const [ratingLoading, setRatingLoading] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleRate = useCallback(
    async (value: number) => {
      if (!messageId || ratingLoading) return;
      setRatingLoading(true);
      try {
        if (currentRating === value) {
          await api.removeRating(messageId);
          setCurrentRating(null);
        } else {
          await api.setRating(messageId, value);
          setCurrentRating(value);
        }
      } catch (e) {
        console.warn("Rating failed:", e);
      } finally {
        setRatingLoading(false);
      }
    },
    [messageId, currentRating, ratingLoading]
  );

  return (
    <div className="message-actions">
      <button className="action-btn" onClick={handleCopy} title={copied ? "Copied!" : "Copy"}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {role === "assistant" && (
        <>
          <button
            className={`action-btn ${currentRating === 1 ? "active-like" : ""}`}
            onClick={() => handleRate(1)}
            title="Like"
            disabled={ratingLoading}
          >
            <ThumbsUpIcon />
          </button>
          <button
            className={`action-btn ${currentRating === -1 ? "active-dislike" : ""}`}
            onClick={() => handleRate(-1)}
            title="Dislike"
            disabled={ratingLoading}
          >
            <ThumbsDownIcon />
          </button>
          {onRegenerate && (
            <button className="action-btn" onClick={onRegenerate} title="Regenerate">
              <RegenerateIcon />
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── SVG Icons ──

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ThumbsUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

function ThumbsDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
    </svg>
  );
}

function RegenerateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
