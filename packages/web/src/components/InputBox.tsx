import { useState, useRef, useCallback, useEffect } from "react";
import { ImageSettingsPicker, VideoSettingsPicker, type ImageSettings, type VideoSettings } from "./MediaSettings.js";
import { ModelPicker } from "./ModelPicker.js";
import type { CatalogModel } from "../lib/model-filter.js";
import type { PickedFile } from "../api/client.js";

/** 输入框形态：普通对话 / 图像生成 / 视频生成 / PPT 制作。 */
export type InputMode = "default" | "image" | "video" | "ppt";

interface InputBoxProps {
  onSend: (content: string, files: PickedFile[], settings?: ImageSettings | VideoSettings) => void;
  onStop: () => void;
  disabled: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** 图像/视频生成 Agent：换「参考图」上传 + 对应的设置选择器。 */
  mode?: InputMode;
  /** 当前 agent 类型可用的模型列表（右下角选择器）。 */
  models?: CatalogModel[];
  /** 当前选中的模型 id（null = 用会话/agent 默认）。 */
  selectedModel?: string | null;
  onModelChange?: (id: string) => void;
}

const MAX_FILES = 5;
const ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,.txt,.md,.csv,.json,application/pdf,.docx,.xlsx,.xls";
/** ppt 模式内容文件的可选类型（不含图片；旧 pptx 可作素材）。 */
const ACCEPT_CONTENT =
  ".txt,.md,.csv,.json,application/pdf,.docx,.xlsx,.xls,.pptx";

/** 上传按钮悬停提示中展示的受支持文件类型。 */
const SUPPORTED_TYPES: { label: string; exts: string }[] = [
  { label: "图片", exts: "JPG / PNG / WebP / GIF" },
  { label: "文档", exts: "PDF / Word(docx)" },
  { label: "表格", exts: "Excel(xlsx/xls) / CSV" },
  { label: "文本", exts: "TXT / Markdown / JSON" },
];

export function InputBox({
  onSend,
  onStop,
  disabled,
  placeholder,
  autoFocus,
  mode = "default",
  models = [],
  selectedModel = null,
  onModelChange,
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // 图像/视频生成共用「参考图」上传 + 渐变发送 + 设置选择器。
  const mediaMode = mode === "image" || mode === "video";
  const pptMode = mode === "ppt";
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // One object URL per image file, created once when the file is picked and
  // revoked on remove/send/unmount. Kept in a ref (not state) and created in
  // the event handler — never inline in JSX (would leak a blob URL per render)
  // and never in a render/effect path (StrictMode double-invokes those).
  const settingsRef = useRef<ImageSettings | VideoSettings | undefined>(undefined);
  const handleSettingsChange = useCallback((s: ImageSettings | VideoSettings) => { settingsRef.current = s; }, []);

  const urlsRef = useRef<Map<File, string>>(new Map());
  const revokeAll = useCallback(() => {
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, []);
  useEffect(() => revokeAll, [revokeAll]);

  const addFiles = useCallback((picked: FileList | null) => {
    if (!picked) return;
    const incoming = Array.from(picked);
    setFiles((prev) => {
      const next = [...prev];
      for (const f of incoming) {
        if (next.length >= MAX_FILES) break;
        next.push(f);
      }
      return next;
    });
    // Create preview URLs outside the state updater (which StrictMode may run
    // twice). Extra URLs for files dropped by the cap are cleared on unmount.
    for (const f of incoming) {
      if (f.type.startsWith("image/") && !urlsRef.current.has(f)) {
        urlsRef.current.set(f, URL.createObjectURL(f));
      }
    }
  }, []);

  const removeFile = useCallback((idx: number) => {
    setFiles((prev) => {
      const f = prev[idx];
      const url = f && urlsRef.current.get(f);
      if (f && url) {
        URL.revokeObjectURL(url);
        urlsRef.current.delete(f);
      }
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    const hasFiles = files.length > 0 || !!templateFile;
    if ((!trimmed && !hasFiles) || disabled) return;
    const picked: PickedFile[] = pptMode
      ? [
          ...(templateFile ? [{ file: templateFile, slot: "ppt_template" as const }] : []),
          ...files.map((f) => ({ file: f, slot: "content" as const })),
        ]
      : files.map((f) => ({ file: f }));
    onSend(trimmed, picked, mediaMode ? settingsRef.current : undefined);
    setValue("");
    setFiles([]);
    setTemplateFile(null);
    revokeAll();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value, files, templateFile, disabled, onSend, revokeAll, mediaMode, pptMode]);

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
      {!mediaMode && files.some((f) => f.type.startsWith("image/")) && (
        <div className="input-modal-hint" role="note">
          <span aria-hidden>🖼️</span>
          图片需所选模型支持多模态（视觉）能力才能识别
        </div>
      )}
      {(files.length > 0 || templateFile) && (
        <div className="input-attachments">
          {templateFile && (
            <div className="attachment-chip" key="__template">
              <span className="attachment-slot-badge badge-template">模版</span>
              <span className="attachment-name" title={templateFile.name}>{templateFile.name}</span>
              <button className="attachment-remove" onClick={() => setTemplateFile(null)} title="移除" type="button">✕</button>
            </div>
          )}
          {files.map((f, i) => (
            <div className="attachment-chip" key={i}>
              {pptMode && <span className="attachment-slot-badge badge-content">内容</span>}
              {f.type.startsWith("image/") && urlsRef.current.get(f) ? (
                <img className="attachment-thumb" src={urlsRef.current.get(f)} alt={f.name} />
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
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={mediaMode ? "image/*" : pptMode ? ACCEPT_CONTENT : ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={templateInputRef}
          type="file"
          accept=".pptx"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setTemplateFile(f); // 重复选择 = 替换
            e.target.value = "";
          }}
        />
        <div className="input-toolbar-left">
          {mediaMode && (
            <button
              type="button"
              className="btn-reference"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || files.length >= MAX_FILES}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="14" height="14" rx="2.5" />
                <circle cx="8" cy="8" r="1.4" />
                <path d="m17 13-4-4-7 7" />
                <path d="M18.5 16.5v5M16 19h5" />
              </svg>
              参考图
            </button>
          )}
          {pptMode && (
            <>
              <button
                type="button"
                className="btn-reference"
                onClick={() => templateInputRef.current?.click()}
                disabled={disabled}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="13" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </svg>
                PPT 模版
              </button>
              <button
                type="button"
                className="btn-reference"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || files.length >= MAX_FILES}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                内容文件
              </button>
            </>
          )}
        </div>
        <div className="input-toolbar-right">
          {!mediaMode && !pptMode && (
            <div className="upload-wrap">
              <button
                type="button"
                className="btn-upload"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || files.length >= MAX_FILES}
                aria-label="上传文件"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <div className="upload-tooltip" role="tooltip">
                <div className="upload-tooltip-title">📎 支持上传的文件</div>
                <ul className="upload-tooltip-list">
                  {SUPPORTED_TYPES.map((t) => (
                    <li key={t.label}>
                      <span className="upload-tooltip-tag">{t.label}</span>
                      <span className="upload-tooltip-exts">{t.exts}</span>
                    </li>
                  ))}
                </ul>
                <div className="upload-tooltip-hint">最多 {MAX_FILES} 个文件</div>
              </div>
            </div>
          )}
          {onModelChange && (
            <ModelPicker
              models={models}
              value={selectedModel}
              onChange={onModelChange}
              disabled={disabled}
            />
          )}
          {mode === "image" && (
            <ImageSettingsPicker disabled={disabled} onChange={handleSettingsChange} />
          )}
          {mode === "video" && (
            <VideoSettingsPicker disabled={disabled} onChange={handleSettingsChange} />
          )}
          {disabled ? (
            <button onClick={onStop} className="btn-stop" title="停止">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              className={`btn-send ${mediaMode ? "btn-send--grad" : ""}`}
              disabled={!value.trim() && files.length === 0 && !templateFile}
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
