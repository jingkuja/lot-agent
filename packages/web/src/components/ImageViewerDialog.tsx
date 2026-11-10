import { useEffect, useId, useRef } from "react";
import { useI18n } from "../i18n/index.js";

export interface ViewerImage {
  url: string;
  /** Download file name. */
  name: string;
  /** What the image is (封面 / 主图 / 长图 …), shown as the title. */
  label?: string;
}

interface Props {
  images: ViewerImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Start editing the image on screen; undefined hides 编辑. */
  onEdit?: (index: number) => void;
}

/** Enlarged view of one generated image, with its own download and stepping through the rest of the set. */
export function ImageViewerDialog({ images, index, onIndexChange, onClose, onEdit }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const image = images[index] ?? images[0];
  const many = images.length > 1;
  const step = (delta: number) => onIndexChange((index + delta + images.length) % images.length);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog ref={dialog} className="image-viewer" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}
      onKeyDown={(event) => {
        if (!many) return;
        if (event.key === "ArrowLeft") step(-1);
        if (event.key === "ArrowRight") step(1);
      }}>
      <header className="image-edit-head">
        <h2 id={titleId}>{image.label ?? t("查看图片")}{many && <span className="image-viewer-count">{index + 1} / {images.length}</span>}</h2>
        <button type="button" className="image-edit-close" onClick={onClose} aria-label={t("关闭")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="image-viewer-stage">
        {many && (
          <button type="button" className="image-viewer-nav image-viewer-nav--prev" onClick={() => step(-1)} aria-label={t("上一张")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 6-6 6 6 6" /></svg>
          </button>
        )}
        <img src={image.url} alt={image.name} />
        {many && (
          <button type="button" className="image-viewer-nav image-viewer-nav--next" onClick={() => step(1)} aria-label={t("下一张")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        )}
      </div>
      <footer className="image-viewer-actions">
        {onEdit && <button type="button" className="image-viewer-edit" onClick={() => onEdit(index)}>{t("编辑")}</button>}
        <a className="gen-asset-download" href={image.url} download={image.name} target="_blank" rel="noreferrer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12" />
            <path d="m7 11 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
          {t("下载")}</a>
      </footer>
    </dialog>
  );
}
