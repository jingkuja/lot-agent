import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { ImageSettingsPicker, VideoSettingsPicker, type ImageSettings, type VideoSettings } from "./MediaSettings.js";
import { DEFAULT_IMAGE_QUALITY, DEFAULT_IMAGE_SIZE, imageSizeError } from "../lib/image-settings.js";
import { ModelPicker } from "./ModelPicker.js";
import {
  isSeedance25Model,
  isSeedanceModel,
  missingSeedanceMentions,
  seedanceAssetMention,
  type CatalogModel,
} from "../lib/model-filter.js";
import type { PickedFile } from "../api/client.js";
import { api, type KnowledgeBase, type KnowledgeBaseRef } from "../api/client.js";
import { KnowledgeBaseModal } from "./KnowledgeBaseModal.js";

/** 输入框形态：普通对话 / 图像生成 / 视频生成 / PPT 制作 / 合同对比。 */
export type InputMode = "default" | "image" | "video" | "ppt" | "contract";

export interface InputBoxHandle {
  getFiles: () => PickedFile[];
  getSettings: () => ImageSettings | VideoSettings | undefined;
  getImageSettingsError: () => string | null;
  getMissingMentions: () => string[];
}

interface InputBoxProps {
  onSend?: (
    content: string,
    files: PickedFile[],
    settings?: ImageSettings | VideoSettings,
    knowledgeBases?: KnowledgeBaseRef[]
  ) => void;
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** 图像/视频生成 Agent：换「参考图」上传 + 对应的设置选择器。 */
  mode?: InputMode;
  /** 当前 agent 类型可用的模型列表（右下角选择器）。 */
  models?: CatalogModel[];
  /** 当前选中的模型 id（null = 用会话/agent 默认）。 */
  selectedModel?: string | null;
  onModelChange?: (id: string) => void;
  allowKnowledgeBase?: boolean;
  knowledgeBases?: KnowledgeBaseRef[];
  onKnowledgeBasesChange?: (items: KnowledgeBaseRef[]) => void;
  /** 嵌入表单：受控文案、不发送、不展示发送按钮。 */
  embedded?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  /** 视频时长选项；不传则沿用项目默认 5秒 / 10秒。 */
  videoDurations?: readonly string[];
}

const MAX_FILES = 5;
const MAX_IMAGE_REFERENCE_IMAGES = 5;
const MAX_VIDEO_REFERENCE_IMAGES = 5;
const MAX_VIDEO_REFERENCE_VIDEOS = 2;
const MAX_VIDEO_REFERENCE_AUDIOS = 2;
const ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,.txt,.md,.csv,.json,application/pdf,.docx,.xlsx,.xls";
/** ppt 模式内容文件的可选类型（不含图片；旧 pptx 可作素材）。 */
const ACCEPT_CONTENT =
  ".txt,.md,.csv,.json,application/pdf,.docx,.xlsx,.xls,.pptx";
/** contract 模式合同文件的可选类型（纯文档，不含图片/表格）。 */
const ACCEPT_CONTRACT = ".txt,.md,application/pdf,.docx";

/** 上传按钮悬停提示中展示的受支持文件类型。 */
const SUPPORTED_TYPES: { label: string; exts: string }[] = [
  { label: "图片", exts: "JPG / PNG / WebP / GIF" },
  { label: "文档", exts: "PDF / Word(docx)" },
  { label: "表格", exts: "Excel(xlsx/xls) / CSV" },
  { label: "文本", exts: "TXT / Markdown / JSON" },
];

export const InputBox = forwardRef<InputBoxHandle, InputBoxProps>(function InputBox({
  onSend,
  onStop,
  disabled = false,
  placeholder,
  autoFocus,
  mode = "default",
  models = [],
  selectedModel = null,
  onModelChange,
  allowKnowledgeBase = false,
  knowledgeBases = [],
  onKnowledgeBasesChange = () => {},
  embedded = false,
  value,
  onChange,
  videoDurations,
}: InputBoxProps, ref) {
  const [internalValue, setInternalValue] = useState("");
  const promptValue = value !== undefined ? value : internalValue;
  const setPromptValue = onChange ?? setInternalValue;
  const noModels = !!onModelChange && models.length === 0;
  const [noModelNotice, setNoModelNotice] = useState(false);
  const [uploadLimitNotice, setUploadLimitNotice] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeBase[]>([]);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [referenceVideoFiles, setReferenceVideoFiles] = useState<File[]>([]);
  const [referenceAudioFiles, setReferenceAudioFiles] = useState<File[]>([]);
  const [firstFrameFile, setFirstFrameFile] = useState<File | null>(null);
  const [lastFrameFile, setLastFrameFile] = useState<File | null>(null);
  // 图像/视频生成共用「参考图」上传 + 渐变发送 + 设置选择器。
  const mediaMode = mode === "image" || mode === "video";
  const videoMode = mode === "video";
  const effectiveVideoModel = selectedModel ?? models[0]?.id ?? "";
  const seedanceVideo = videoMode && isSeedanceModel(effectiveVideoModel);
  const seedance25Video = videoMode && isSeedance25Model(effectiveVideoModel);
  const lockAdaptive = seedanceVideo && referenceVideoFiles.length > 0;
  const missingMentions = seedance25Video
    ? missingSeedanceMentions(promptValue, {
        images: files.length,
        videos: referenceVideoFiles.length,
        audios: referenceAudioFiles.length,
      })
    : [];
  const maxFiles = videoMode
    ? MAX_VIDEO_REFERENCE_IMAGES
    : mode === "image"
      ? MAX_IMAGE_REFERENCE_IMAGES
      : MAX_FILES;
  const pptMode = mode === "ppt";
  const contractMode = mode === "contract";
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [backgroundFiles, setBackgroundFiles] = useState<File[]>([]);
  const [oldContractFile, setOldContractFile] = useState<File | null>(null);
  const [newContractFile, setNewContractFile] = useState<File | null>(null);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const oldContractInputRef = useRef<HTMLInputElement>(null);
  const newContractInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceVideoInputRef = useRef<HTMLInputElement>(null);
  const referenceAudioInputRef = useRef<HTMLInputElement>(null);
  const firstFrameInputRef = useRef<HTMLInputElement>(null);
  const lastFrameInputRef = useRef<HTMLInputElement>(null);

  // One object URL per image file, created once when the file is picked and
  // revoked on remove/send/unmount. Kept in a ref (not state) and created in
  // the event handler — never inline in JSX (would leak a blob URL per render)
  // and never in a render/effect path (StrictMode double-invokes those).
  const settingsRef = useRef<ImageSettings | VideoSettings | undefined>(
    mode === "image" ? { size: DEFAULT_IMAGE_SIZE, n: 1, quality: DEFAULT_IMAGE_QUALITY } : undefined
  );
  const [imageSettingsError, setImageSettingsError] = useState<string | null>(null);
  const handleSettingsChange = useCallback((s: ImageSettings | VideoSettings) => { settingsRef.current = s; }, []);
  const handleImageSettingsError = useCallback((error: string | null) => { setImageSettingsError(error); }, []);
  const effectiveImageModel = selectedModel ?? models[0]?.id ?? null;

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
      const room = Math.max(0, maxFiles - prev.length);
      if (mode === "image" && incoming.length > room) setUploadLimitNotice(true);
      const next = [...prev];
      for (const f of incoming) {
        if (next.length >= maxFiles) break;
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
  }, [maxFiles, mode]);

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
    setUploadLimitNotice(false);
  }, []);

  const loadKnowledgeBases = useCallback(async () => {
    setKnowledgeLoading(true);
    setKnowledgeError(null);
    try {
      const response = await api.listKnowledgeBases();
      setKnowledgeItems(response.data);
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : "知识库加载失败");
    } finally {
      setKnowledgeLoading(false);
    }
  }, []);

  const openKnowledgeBases = useCallback(() => {
    setKnowledgeOpen(true);
    void loadKnowledgeBases();
  }, [loadKnowledgeBases]);

  const setFrameFile = useCallback(
    (setter: (file: File | null) => void, previous: File | null, file: File | null) => {
      if (previous) {
        const url = urlsRef.current.get(previous);
        if (url) URL.revokeObjectURL(url);
        urlsRef.current.delete(previous);
      }
      if (file && file.type.startsWith("image/") && !urlsRef.current.has(file)) {
        urlsRef.current.set(file, URL.createObjectURL(file));
      }
      setter(file);
    },
    []
  );

  const collectPickedFiles = useCallback((): PickedFile[] => {
    if (videoMode) {
      return [
        ...files.map((f) => ({ file: f, slot: "video_reference_image" as const })),
        ...referenceVideoFiles.map((f) => ({ file: f, slot: "video_reference_video" as const })),
        ...referenceAudioFiles.map((f) => ({ file: f, slot: "video_reference_audio" as const })),
        ...(firstFrameFile ? [{ file: firstFrameFile, slot: "video_first_frame" as const }] : []),
        ...(lastFrameFile ? [{ file: lastFrameFile, slot: "video_last_frame" as const }] : []),
      ];
    }
    if (pptMode) {
      return [
        ...(templateFile ? [{ file: templateFile, slot: "ppt_template" as const }] : []),
        ...backgroundFiles.map((f) => ({ file: f, slot: "ppt_background" as const })),
        ...files.map((f) => ({ file: f, slot: "content" as const })),
      ];
    }
    if (contractMode) {
      return [
        ...(oldContractFile ? [{ file: oldContractFile, slot: "contract_old" as const }] : []),
        ...(newContractFile ? [{ file: newContractFile, slot: "contract_new" as const }] : []),
      ];
    }
    return files.map((f) => ({ file: f }));
  }, [files, referenceVideoFiles, referenceAudioFiles, firstFrameFile, lastFrameFile, templateFile, backgroundFiles, oldContractFile, newContractFile, videoMode, pptMode, contractMode]);

  useImperativeHandle(ref, () => ({
    getFiles: collectPickedFiles,
    getSettings: () => mediaMode ? settingsRef.current : undefined,
    getImageSettingsError: () => imageSettingsError,
    getMissingMentions: () => missingMentions,
  }), [collectPickedFiles, mediaMode, imageSettingsError, missingMentions]);

  const handleSend = useCallback(() => {
    const trimmed = promptValue.trim();
    if (noModels) {
      setNoModelNotice(true);
      return;
    }
    if (mode === "image") {
      const current = settingsRef.current as ImageSettings | undefined;
      const err = imageSizeError(current?.size ?? "", effectiveImageModel);
      if (err) {
        setImageSettingsError(err);
        return;
      }
    }
    const picked = collectPickedFiles();
    const hasFiles = picked.length > 0;
    if ((!trimmed && !hasFiles) || disabled || !onSend) return;
    onSend(trimmed, picked, mediaMode ? settingsRef.current : undefined, knowledgeBases);
    setPromptValue("");
    setUploadLimitNotice(false);
    setFiles([]);
    setReferenceVideoFiles([]);
    setReferenceAudioFiles([]);
    setFirstFrameFile(null);
    setLastFrameFile(null);
    setTemplateFile(null);
    setBackgroundFiles([]);
    setOldContractFile(null);
    setNewContractFile(null);
    revokeAll();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [promptValue, collectPickedFiles, disabled, onSend, revokeAll, mediaMode, noModels, knowledgeBases, mode, effectiveImageModel, setPromptValue]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (embedded) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, embedded]
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 320) + "px";
    }
  }, []);

  return (
    <div className={`input-box${embedded ? " input-box--embedded" : ""}`}>
      {!mediaMode && files.some((f) => f.type.startsWith("image/")) && (
        <div className="input-modal-hint" role="note">
          <span aria-hidden>🖼️</span>
          图片需所选模型支持多模态（视觉）能力才能识别
        </div>
      )}
      {noModelNotice && (
        <div className="input-modal-hint" role="alert">
          <span aria-hidden>⚠️</span>
          暂无能使用模型，请前往订阅管理页面设置 api-key 和 key 能访问的模型
        </div>
      )}
      {mode === "image" && imageSettingsError && (
        <div className="input-modal-hint input-modal-hint--error" role="alert">
          <span aria-hidden>⚠️</span>
          {imageSettingsError}
        </div>
      )}
      {mode === "image" && (uploadLimitNotice || files.length >= MAX_IMAGE_REFERENCE_IMAGES) && (
        <div className="input-modal-hint" role="alert">
          <span aria-hidden>⚠️</span>
          参考图最多 {MAX_IMAGE_REFERENCE_IMAGES} 张，不能再上传
        </div>
      )}
      {lockAdaptive && (
        <div className="input-modal-hint" role="alert">
          <span aria-hidden>⚠️</span>
          提供参考视频后视频时长和比例不能选择，自动适配参考视频
        </div>
      )}
      {seedance25Video && missingMentions.length > 0 && (
        <div className="input-modal-hint" role="alert">
          <span aria-hidden>⚠️</span>
          当前提示词尚未写出
          {missingMentions.map((tag) => (
            <code key={tag} className="input-seedance-mention">{tag}</code>
          ))}
        </div>
      )}
      {(knowledgeBases.length > 0 || files.length > 0 || referenceVideoFiles.length > 0 || referenceAudioFiles.length > 0 || firstFrameFile || lastFrameFile || templateFile || backgroundFiles.length > 0 || oldContractFile || newContractFile) && (
        <div className="input-attachments">
          {knowledgeBases.map((item) => (
            <div className="attachment-chip knowledge-chip" key={`kb:${item.id}`}>
              <span className="attachment-slot-badge badge-knowledge">知识库</span>
              <span aria-hidden>▤</span>
              <span className="attachment-name" title={item.name}>{item.name}</span>
              <button
                className="attachment-remove"
                onClick={() => onKnowledgeBasesChange(knowledgeBases.filter((kb) => kb.id !== item.id))}
                title="移除"
                type="button"
              >✕</button>
            </div>
          ))}
          {templateFile && (
            <div className="attachment-chip" key="__template">
              <span className="attachment-slot-badge badge-template">模版</span>
              <span className="attachment-name" title={templateFile.name}>{templateFile.name}</span>
              <button className="attachment-remove" onClick={() => setTemplateFile(null)} title="移除" type="button">✕</button>
            </div>
          )}
          {backgroundFiles.map((f, i) => (
            <div className="attachment-chip" key={`__bg${i}`}>
              <span className="attachment-slot-badge badge-background">背景</span>
              <span className="attachment-name" title={f.name}>{f.name}</span>
              <button type="button" className="attachment-remove" onClick={() => setBackgroundFiles((p) => p.filter((_, j) => j !== i))} title="移除">✕</button>
            </div>
          ))}
          {oldContractFile && (
            <div className="attachment-chip" key="__contract_old">
              <span className="attachment-slot-badge badge-old">旧版</span>
              <span className="attachment-name" title={oldContractFile.name}>{oldContractFile.name}</span>
              <button className="attachment-remove" onClick={() => setOldContractFile(null)} title="移除" type="button">✕</button>
            </div>
          )}
          {newContractFile && (
            <div className="attachment-chip" key="__contract_new">
              <span className="attachment-slot-badge badge-new">新版</span>
              <span className="attachment-name" title={newContractFile.name}>{newContractFile.name}</span>
              <button className="attachment-remove" onClick={() => setNewContractFile(null)} title="移除" type="button">✕</button>
            </div>
          )}
          {videoMode && referenceVideoFiles.map((f, i) => (
            <div className="attachment-chip" key={`__video${i}`}>
              <span className="attachment-slot-badge badge-video-reference">
                {seedance25Video ? `参考视频 ${seedanceAssetMention("Video", i)}` : "参考视频"}
              </span>
              <span className="attachment-attachment-icon" aria-hidden>🎞️</span>
              <span className="attachment-name" title={f.name}>{f.name}</span>
              <button type="button" className="attachment-remove" onClick={() => setReferenceVideoFiles((p) => p.filter((_, j) => j !== i))} title="移除">✕</button>
            </div>
          ))}
          {videoMode && referenceAudioFiles.map((f, i) => (
            <div className="attachment-chip" key={`__audio${i}`}>
              <span className="attachment-slot-badge badge-audio-reference">
                {seedance25Video ? `参考音频 ${seedanceAssetMention("Audio", i)}` : "参考音频"}
              </span>
              <span className="attachment-attachment-icon" aria-hidden>🔊</span>
              <span className="attachment-name" title={f.name}>{f.name}</span>
              <button type="button" className="attachment-remove" onClick={() => setReferenceAudioFiles((p) => p.filter((_, j) => j !== i))} title="移除">✕</button>
            </div>
          ))}
          {videoMode && firstFrameFile && (
            <div className="attachment-chip" key="__first_frame">
              <span className="attachment-slot-badge badge-frame">首帧</span>
              {urlsRef.current.get(firstFrameFile) && <img className="attachment-thumb" src={urlsRef.current.get(firstFrameFile)} alt={firstFrameFile.name} />}
              <span className="attachment-name" title={firstFrameFile.name}>{firstFrameFile.name}</span>
              <button type="button" className="attachment-remove" onClick={() => setFrameFile(setFirstFrameFile, firstFrameFile, null)} title="移除">✕</button>
            </div>
          )}
          {videoMode && lastFrameFile && (
            <div className="attachment-chip" key="__last_frame">
              <span className="attachment-slot-badge badge-frame">尾帧</span>
              {urlsRef.current.get(lastFrameFile) && <img className="attachment-thumb" src={urlsRef.current.get(lastFrameFile)} alt={lastFrameFile.name} />}
              <span className="attachment-name" title={lastFrameFile.name}>{lastFrameFile.name}</span>
              <button type="button" className="attachment-remove" onClick={() => setFrameFile(setLastFrameFile, lastFrameFile, null)} title="移除">✕</button>
            </div>
          )}
          {files.map((f, i) => (
            <div className="attachment-chip" key={i}>
              {mediaMode && (
                <span className="attachment-slot-badge badge-image-reference">
                  {seedance25Video
                    ? `参考图 ${seedanceAssetMention("Image", i)}`
                    : mode === "image" && files.length > 1
                      ? `参考图${i + 1}`
                      : "参考图"}
                </span>
              )}
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
        value={promptValue}
        onChange={(e) => { setPromptValue(e.target.value); if (noModelNotice) setNoModelNotice(false); }}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder={
          disabled && !embedded
            ? "Agent 正在思考…"
            : placeholder ?? "输入消息，Enter 发送，Shift+Enter 换行"
        }
        disabled={disabled}
        rows={1}
        autoFocus={autoFocus}
      />
      <div className={`input-toolbar ${videoMode ? "input-toolbar--video" : ""}`}>
        <input
          ref={fileInputRef}
          type="file"
          multiple={maxFiles > 1}
          accept={mediaMode ? "image/*" : pptMode ? ACCEPT_CONTENT : ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={referenceVideoInputRef}
          type="file"
          accept="video/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            const next = [...referenceVideoFiles, ...picked].slice(0, MAX_VIDEO_REFERENCE_VIDEOS);
            if (seedanceVideo && referenceVideoFiles.length === 0 && next.length > 0) {
              window.alert("提供参考视频后视频时长和比例不能选择，自动适配参考视频");
            }
            setReferenceVideoFiles(next);
            e.target.value = "";
          }}
        />
        <input
          ref={referenceAudioInputRef}
          type="file"
          accept="audio/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            setReferenceAudioFiles((prev) => [...prev, ...picked].slice(0, MAX_VIDEO_REFERENCE_AUDIOS));
            e.target.value = "";
          }}
        />
        <input
          ref={firstFrameInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            if (f) setFrameFile(setFirstFrameFile, firstFrameFile, f);
            e.target.value = "";
          }}
        />
        <input
          ref={lastFrameInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            if (f) setFrameFile(setLastFrameFile, lastFrameFile, f);
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
        <input
          ref={backgroundInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            setBackgroundFiles((prev) => [...prev, ...picked].slice(0, 3));
            e.target.value = "";
          }}
        />
        <input
          ref={oldContractInputRef}
          type="file"
          accept={ACCEPT_CONTRACT}
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setOldContractFile(f); // 重复选择 = 替换
            e.target.value = "";
          }}
        />
        <input
          ref={newContractInputRef}
          type="file"
          accept={ACCEPT_CONTRACT}
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setNewContractFile(f); // 重复选择 = 替换
            e.target.value = "";
          }}
        />
        <div className="input-toolbar-left">
          {mediaMode && !videoMode && (
            <button
              type="button"
              className="btn-reference"
              onClick={() => {
                if (files.length >= MAX_IMAGE_REFERENCE_IMAGES) {
                  setUploadLimitNotice(true);
                  return;
                }
                fileInputRef.current?.click();
              }}
              disabled={disabled}
              title="最多5张"
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
          {videoMode && (
            <>
              <button
                type="button"
                className="btn-reference"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || files.length >= MAX_VIDEO_REFERENCE_IMAGES}
                title={seedance25Video ? "最多5张；提示词须按上传顺序写出 @Image1、@Image2…" : "最多5张"}
              >
                🖼️ 参考图
              </button>
              <button
                type="button"
                className="btn-reference"
                onClick={() => referenceVideoInputRef.current?.click()}
                disabled={disabled || referenceVideoFiles.length >= MAX_VIDEO_REFERENCE_VIDEOS}
                title={seedance25Video ? "最多2个；提示词须按上传顺序写出 @Video1、@Video2…" : "最多2个"}
              >
                🎞️ 参考视频
              </button>
              <button
                type="button"
                className="btn-reference"
                onClick={() => referenceAudioInputRef.current?.click()}
                disabled={disabled || referenceAudioFiles.length >= MAX_VIDEO_REFERENCE_AUDIOS}
                title={seedance25Video ? "最多2个；提示词须按上传顺序写出 @Audio1、@Audio2…" : "最多2个"}
              >
                🔊 参考音频
              </button>
              <button
                type="button"
                className="btn-reference"
                onClick={() => firstFrameInputRef.current?.click()}
                disabled={disabled}
                title={seedance25Video ? "首帧图比例需与生成视频比例一致" : undefined}
              >
                首帧图
              </button>
              <button
                type="button"
                className="btn-reference"
                onClick={() => lastFrameInputRef.current?.click()}
                disabled={disabled}
                title={seedance25Video ? "尾帧图比例需与生成视频比例一致" : undefined}
              >
                尾帧图
              </button>
            </>
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
                onClick={() => backgroundInputRef.current?.click()}
                disabled={disabled || backgroundFiles.length >= 3}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
                背景图
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
          {contractMode && (
            <>
              <button
                type="button"
                className="btn-reference"
                onClick={() => oldContractInputRef.current?.click()}
                disabled={disabled}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M9 15h6M9 11h6" />
                </svg>
                旧版合同
              </button>
              <button
                type="button"
                className="btn-reference"
                onClick={() => newContractInputRef.current?.click()}
                disabled={disabled}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M12 11v6M9 14h6" />
                </svg>
                新版合同
              </button>
            </>
          )}
        </div>
        <div className="input-toolbar-right">
          {!mediaMode && !pptMode && !contractMode && (
            <>
            {allowKnowledgeBase && (
              <button
                type="button"
                className={`btn-knowledge${knowledgeBases.length ? " active" : ""}`}
                onClick={openKnowledgeBases}
                disabled={disabled}
                title="选择个人知识库"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <ellipse cx="12" cy="5" rx="7" ry="3" />
                  <path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
                  <path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
                </svg>
                <span>知识库</span>
              </button>
            )}
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
            </>
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
            <ImageSettingsPicker
              disabled={disabled}
              selectedModel={effectiveImageModel}
              onChange={handleSettingsChange}
              onError={handleImageSettingsError}
            />
          )}
          {mode === "video" && (
            <VideoSettingsPicker disabled={disabled} lockAdaptive={lockAdaptive} durations={videoDurations} onChange={handleSettingsChange} />
          )}
          {!embedded && (disabled ? (
            <button onClick={onStop} className="btn-stop" title="停止">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              className={`btn-send ${mediaMode ? "btn-send--grad" : ""}`}
              disabled={(mode === "image" && !!imageSettingsError) || (!promptValue.trim() && files.length === 0 && (!videoMode || (referenceVideoFiles.length === 0 && referenceAudioFiles.length === 0 && !firstFrameFile && !lastFrameFile)) && !templateFile && backgroundFiles.length === 0 && !oldContractFile && !newContractFile)}
              title="发送"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          ))}
        </div>
      </div>
      {knowledgeOpen && (
        <KnowledgeBaseModal
          items={knowledgeItems}
          selected={knowledgeBases}
          loading={knowledgeLoading}
          error={knowledgeError}
          onConfirm={onKnowledgeBasesChange}
          onClose={() => setKnowledgeOpen(false)}
          onRetry={() => void loadKnowledgeBases()}
        />
      )}
    </div>
  );
});
