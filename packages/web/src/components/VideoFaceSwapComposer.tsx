import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgeBaseRef, PickedFile } from "../api/client.js";
import { useI18n } from "../i18n/index.js";
import { VIDEO_FACE_SWAP_MODEL } from "../lib/model-filter.js";
import {
  DEFAULT_VIDEO_FACE_SWAP_RESOLUTION,
  VIDEO_FACE_SWAP_QUALITIES,
  type VideoFaceSwapResolution,
  type VideoFaceSwapSettings,
} from "../lib/video-settings.js";

const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/*";
const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,video/*";

/** Remembered across remounts when switching between empty hero and chat list. */
let lastFaceSwapResolution: VideoFaceSwapResolution = DEFAULT_VIDEO_FACE_SWAP_RESOLUTION;

export interface VideoFaceSwapComposerProps {
  disabled?: boolean;
  attachment?: { id: string; file: File };
  onAttachmentConsumed?: () => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onSend?: (
    content: string,
    files: PickedFile[],
    settings?: VideoFaceSwapSettings,
    knowledgeBases?: KnowledgeBaseRef[],
    requestId?: string,
    modelOverride?: string,
  ) => void | Promise<void | "accepted" | "rejected" | "unknown">;
  onStop?: () => void;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(?:jpe?g|png|webp|gif)$/i.test(file.name);
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || /\.(?:mp4|mov|webm|m4v)$/i.test(file.name);
}

function PortraitIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.8 19a5.6 5.6 0 0 1 10.4 0" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="5" width="14" height="14" rx="2.5" />
      <path d="m16.5 10 5-3v10l-5-3" />
    </svg>
  );
}

export function VideoFaceSwapComposer({
  disabled: streaming = false,
  attachment,
  onAttachmentConsumed,
  onDraftChange,
  onSend,
  onStop,
}: VideoFaceSwapComposerProps) {
  const { t } = useI18n();
  const [characterImage, setCharacterImage] = useState<File | null>(null);
  const [originalVideo, setOriginalVideo] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [resolution, setResolutionState] = useState<VideoFaceSwapResolution>(() => lastFaceSwapResolution);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState<"image" | "video" | null>(null);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const imageUrlRef = useRef<string | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const consumedAttachment = useRef("");

  const locked = streaming || submitting;
  const hasDraft = Boolean(characterImage || originalVideo);
  const hasDraftRef = useRef(hasDraft);
  hasDraftRef.current = hasDraft;

  const setResolution = useCallback((next: VideoFaceSwapResolution) => {
    lastFaceSwapResolution = next;
    setResolutionState(next);
  }, []);

  const revokeUrl = (ref: React.MutableRefObject<string | null>) => {
    if (ref.current) {
      URL.revokeObjectURL(ref.current);
      ref.current = null;
    }
  };

  useEffect(() => () => {
    revokeUrl(imageUrlRef);
    revokeUrl(videoUrlRef);
  }, []);

  useEffect(() => {
    onDraftChange?.(hasDraft);
  }, [hasDraft, onDraftChange]);

  useEffect(() => {
    const beforeUpdate = (event: Event) => {
      if (hasDraftRef.current) event.preventDefault();
    };
    window.addEventListener("lot:before-update", beforeUpdate);
    return () => window.removeEventListener("lot:before-update", beforeUpdate);
  }, []);

  const pickImage = useCallback((file: File | null) => {
    setError("");
    if (!file) {
      revokeUrl(imageUrlRef);
      setCharacterImage(null);
      setImagePreview(null);
      return;
    }
    if (!isImageFile(file)) {
      setError("请上传图片文件作为人物图片");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("人物图片大小不能超过 150MB");
      return;
    }
    revokeUrl(imageUrlRef);
    const url = URL.createObjectURL(file);
    imageUrlRef.current = url;
    setCharacterImage(file);
    setImagePreview(url);
  }, []);

  const pickVideo = useCallback((file: File | null) => {
    setError("");
    if (!file) {
      revokeUrl(videoUrlRef);
      setOriginalVideo(null);
      setVideoPreview(null);
      return;
    }
    if (!isVideoFile(file)) {
      setError("请上传视频文件作为原始视频");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("原始视频大小不能超过 150MB");
      return;
    }
    revokeUrl(videoUrlRef);
    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    setOriginalVideo(file);
    setVideoPreview(url);
  }, []);

  useEffect(() => {
    if (!attachment || attachment.id === consumedAttachment.current) return;
    consumedAttachment.current = attachment.id;
    const { file } = attachment;
    if (isImageFile(file)) pickImage(file);
    else if (isVideoFile(file)) pickVideo(file);
    else setError("视频换脸仅支持人物图片和原始视频");
    onAttachmentConsumed?.();
  }, [attachment, onAttachmentConsumed, pickImage, pickVideo]);

  const handleSend = useCallback(async () => {
    if (locked || submittingRef.current || !onSend) return;
    if (!characterImage) {
      setError("请先上传人物图片");
      return;
    }
    if (!originalVideo) {
      setError("请先上传原始视频");
      return;
    }
    setError("");
    submittingRef.current = true;
    setSubmitting(true);
    const tierLabel = resolution === "1080p" ? "质量" : "默认";
    const prompt = t("视频换脸（{0}）", [t(tierLabel)]);
    const picked: PickedFile[] = [
      { file: characterImage, slot: "video_reference_image" },
      { file: originalVideo, slot: "video_reference_video" },
    ];
    let result: void | "accepted" | "rejected" | "unknown";
    try {
      result = await onSend(prompt, picked, { resolution }, undefined, undefined, VIDEO_FACE_SWAP_MODEL);
    } catch {
      result = "rejected";
      setError("提交失败，请稍后重试");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
    if (result === "rejected") return;
    revokeUrl(imageUrlRef);
    revokeUrl(videoUrlRef);
    setCharacterImage(null);
    setOriginalVideo(null);
    setImagePreview(null);
    setVideoPreview(null);
  }, [characterImage, originalVideo, locked, onSend, resolution, t]);

  const canSend = Boolean(characterImage && originalVideo) && !locked;

  return (
    <div className="input-box input-box--face-swap">
      <input
        ref={imageInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        style={{ display: "none" }}
        aria-label={t("人物图片")}
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          if (file) pickImage(file);
          event.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        style={{ display: "none" }}
        aria-label={t("原始视频")}
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          if (file) pickVideo(file);
          event.target.value = "";
        }}
      />

      {error && <p className="input-modal-hint" role="alert">{t(error)}</p>}

      <div className="face-swap-grid">
        <div
          className={`face-swap-slot${characterImage ? " has-file" : ""}${dragOver === "image" ? " is-dragover" : ""}`}
          onDragOver={(event) => {
            if (locked) return;
            event.preventDefault();
            setDragOver("image");
          }}
          onDragLeave={() => setDragOver((prev) => (prev === "image" ? null : prev))}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(null);
            if (locked) return;
            const file = event.dataTransfer.files?.[0];
            if (file) pickImage(file);
          }}
        >
          <div className="face-swap-slot-head">
            <span className="face-swap-slot-title">{t("人物图片")}</span>
            <span className="face-swap-required">{t("必传")}</span>
          </div>
          {characterImage && imagePreview ? (
            <div className="face-swap-preview">
              <img className="face-swap-preview-media" src={imagePreview} alt={characterImage.name} />
              <div className="face-swap-preview-bar">
                <span className="face-swap-preview-name" title={characterImage.name}>{characterImage.name}</span>
                <div className="face-swap-preview-actions">
                  <button
                    type="button"
                    className="face-swap-action-btn"
                    disabled={locked}
                    onClick={() => imageInputRef.current?.click()}
                  >
                    {t("更换")}
                  </button>
                  <button
                    type="button"
                    className="face-swap-remove-btn"
                    disabled={locked}
                    onClick={() => pickImage(null)}
                    aria-label={t("移除人物图片")}
                    title={t("移除")}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="face-swap-dropzone"
              disabled={locked}
              onClick={() => imageInputRef.current?.click()}
            >
              <span className="face-swap-dropzone-icon"><PortraitIcon /></span>
              <span className="face-swap-dropzone-label">{t("点击或拖拽上传人物图片")}</span>
              <span className="face-swap-dropzone-hint">{t("支持 JPG / PNG / WebP")}</span>
            </button>
          )}
        </div>

        <div
          className={`face-swap-slot${originalVideo ? " has-file" : ""}${dragOver === "video" ? " is-dragover" : ""}`}
          onDragOver={(event) => {
            if (locked) return;
            event.preventDefault();
            setDragOver("video");
          }}
          onDragLeave={() => setDragOver((prev) => (prev === "video" ? null : prev))}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(null);
            if (locked) return;
            const file = event.dataTransfer.files?.[0];
            if (file) pickVideo(file);
          }}
        >
          <div className="face-swap-slot-head">
            <span className="face-swap-slot-title">{t("原始视频")}</span>
            <span className="face-swap-required">{t("必传")}</span>
          </div>
          {originalVideo && videoPreview ? (
            <div className="face-swap-preview">
              <video className="face-swap-preview-media" src={videoPreview} muted playsInline preload="metadata" />
              <div className="face-swap-preview-bar">
                <span className="face-swap-preview-name" title={originalVideo.name}>{originalVideo.name}</span>
                <div className="face-swap-preview-actions">
                  <button
                    type="button"
                    className="face-swap-action-btn"
                    disabled={locked}
                    onClick={() => videoInputRef.current?.click()}
                  >
                    {t("更换")}
                  </button>
                  <button
                    type="button"
                    className="face-swap-remove-btn"
                    disabled={locked}
                    onClick={() => pickVideo(null)}
                    aria-label={t("移除原始视频")}
                    title={t("移除")}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="face-swap-dropzone"
              disabled={locked}
              onClick={() => videoInputRef.current?.click()}
            >
              <span className="face-swap-dropzone-icon"><VideoIcon /></span>
              <span className="face-swap-dropzone-label">{t("点击或拖拽上传原始视频")}</span>
              <span className="face-swap-dropzone-hint">{t("支持 MP4 / MOV / WebM")}</span>
            </button>
          )}
        </div>
      </div>

      <div className="input-toolbar face-swap-toolbar">
        <div className="input-toolbar-left">
          <div className="face-swap-setting">
            <span className="face-swap-setting-label">{t("画质")}</span>
            <div className="face-swap-quality" role="radiogroup" aria-label={t("画质")}>
              {VIDEO_FACE_SWAP_QUALITIES.map((option) => (
                <button
                  key={option.resolution}
                  type="button"
                  role="radio"
                  aria-checked={resolution === option.resolution}
                  className={`face-swap-quality-btn${resolution === option.resolution ? " active" : ""}`}
                  disabled={locked}
                  onClick={() => setResolution(option.resolution)}
                >
                  <span>{t(option.label)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="input-toolbar-right">
          {submitting && !streaming ? (
            <button type="button" className="btn-send btn-send--grad face-swap-submitting" disabled>
              {t("正在提交…")}
            </button>
          ) : streaming ? (
            <button type="button" onClick={() => onStop?.()} className="btn-stop" title={t("停止")}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              className="btn-send btn-send--grad"
              disabled={!canSend}
              aria-label={t("开始视频换脸")}
              title={canSend ? t("开始视频换脸") : t("请先上传人物图片和原始视频")}
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
