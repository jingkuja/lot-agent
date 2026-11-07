import { useCallback, useRef, useState, type DragEvent } from "react";
import { api } from "../../../api/client.js";
import { useI18n } from "../../../i18n/index.js";
import { BUSINESS_IMAGE_ACCEPT, MAX_BUSINESS_IMAGE_BYTES } from "./business-images.js";

/** A file dropped here belongs to this dialog; the page behind it would start a product import. */
export function keepDrop(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
}

export function ImagePicker({ label, disabled, multiple, onFiles }: {
  label: string; disabled: boolean; multiple?: boolean; onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button
      type="button" className="marketing-image-add" disabled={disabled}
      onClick={() => input.current?.click()}
      onDragOver={keepDrop}
      onDrop={(event) => { keepDrop(event); onFiles(Array.from(event.dataTransfer.files)); }}
    >
      <span aria-hidden>＋</span>{label}
    </button>
    <input
      ref={input} type="file" hidden multiple={multiple} accept={BUSINESS_IMAGE_ACCEPT}
      onChange={(event) => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }}
    />
  </>;
}

export function ImageTile({ url, label, logo, onRemove }: { url: string; label: string; logo?: boolean; onRemove: () => void }) {
  const { t } = useI18n();
  return <div className={`marketing-image-tile${logo ? " is-logo" : ""}`}>
    <img src={url} alt={label} />
    <button type="button" aria-label={t("移除 {0}", [label])} onClick={onRemove}>×</button>
  </div>;
}

export function useImageUpload(onError: (message: string) => void) {
  const [uploading, setUploading] = useState(0);
  const upload = useCallback(async (files: File[]): Promise<Array<{ name: string; url: string }>> => {
    const images = files.filter((file) => BUSINESS_IMAGE_ACCEPT.split(",").includes(file.type));
    if (images.length < files.length) onError("只支持 JPG、PNG、WebP 图片");
    const allowed = images.filter((file) => file.size <= MAX_BUSINESS_IMAGE_BYTES);
    if (allowed.length < images.length) onError("图片不能超过 10MB");
    setUploading((count) => count + allowed.length);
    const uploaded: Array<{ name: string; url: string }> = [];
    for (const file of allowed) {
      try {
        const asset = await api.uploadFile(file);
        uploaded.push({ name: asset.filename, url: asset.url });
      } catch (reason) {
        onError(reason instanceof Error ? reason.message : "上传失败");
      } finally {
        setUploading((count) => count - 1);
      }
    }
    return uploaded;
  }, [onError]);
  return { uploading, upload };
}
