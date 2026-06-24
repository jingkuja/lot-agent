import { useState, useRef, useCallback } from "react";

interface InputBoxProps {
  onSend: (content: string, files: File[]) => void;
  onStop: () => void;
  disabled: boolean;
  /** Bottom-left content (e.g. the agent switcher). */
  leftSlot?: React.ReactNode;
  placeholder?: string;
  autoFocus?: boolean;
}

const MAX_FILES = 5;
const ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,.txt,.md,.csv,.json,application/pdf,.docx";

export function InputBox({
  onSend,
  onStop,
  disabled,
  leftSlot,
  placeholder,
  autoFocus,
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((picked: FileList | null) => {
    if (!picked) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(picked)) {
        if (next.length >= MAX_FILES) break;
        next.push(f);
      }
      return next;
    });
  }, []);

  const removeFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && files.length === 0) || disabled) return;
    onSend(trimmed, files);
    setValue("");
    setFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, files, disabled, onSend]);

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
      {files.length > 0 && (
        <div className="input-attachments">
          {files.map((f, i) => (
            <div className="attachment-chip" key={i}>
              {f.type.startsWith("image/") ? (
                <img className="attachment-thumb" src={URL.createObjectURL(f)} alt={f.name} />
              ) : (
                <span className="attachment-doc-icon" aria-hidden>📄</span>
              )}
              <span className="attachment-name" title={f.name}>{f.name}</span>
              <button
                className="attachment-remove"
                onClick={() => removeFile(i)}
                title="移除"
                type="button"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
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
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            style={{ display: "none" }}
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn-upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || files.length >= MAX_FILES}
            title="上传文件"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
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
              disabled={!value.trim() && files.length === 0}
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
