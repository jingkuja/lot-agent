import { useState, useRef, useCallback } from "react";

interface InputBoxProps {
  onSend: (content: string) => void;
  onStop: () => void;
  disabled: boolean;
  /** Bottom-left content (e.g. the agent switcher). */
  leftSlot?: React.ReactNode;
  placeholder?: string;
  autoFocus?: boolean;
}

export function InputBox({
  onSend,
  onStop,
  disabled,
  leftSlot,
  placeholder,
  autoFocus,
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 320) + "px";
    }
  }, []);

  return (
    <div className="input-box">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder={
          disabled
            ? "Agent 正在思考…"
            : placeholder ?? "输入消息，Enter 发送，Shift+Enter 换行"
        }
        disabled={disabled}
        rows={1}
        autoFocus={autoFocus}
      />
      <div className="input-toolbar">
        <div className="input-toolbar-left">{leftSlot}</div>
        <div className="input-toolbar-right">
          {disabled ? (
            <button onClick={onStop} className="btn-stop" title="停止">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              className="btn-send"
              disabled={!value.trim()}
              title="发送"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
