import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api/client.js";
import { useI18n } from "../i18n/index.js";
import { nearestImageRatio, type PosterLibraryImage } from "../lib/image-settings.js";

export interface PosterSelection extends PosterLibraryImage {
  ratio: string;
}

export function PosterReferencePicker({ selected, disabled, onChange }: {
  selected: PosterSelection | null;
  disabled: boolean;
  onChange: (selection: PosterSelection | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <div className="poster-reference">
    <button type="button" className="poster-reference-trigger" aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)}
      aria-label={t(selected ? "更换爆款参考图" : "选择爆款")}>
      <span className="poster-reference-thumb">
        {selected ? <><img src={selected.url} alt="" /><span className="poster-reference-index" aria-hidden="true">1</span></> : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 4h12v12M4 8h12v12H4ZM4 17l4-4 3 3 2-2 3 3" />
          </svg>
        )}
      </span>
      <span className="poster-reference-label">
        <strong>{t(selected?.category ?? "选择爆款")}</strong>
        <small title={selected?.name}>{selected?.name ?? t("从分类中选一张参考图")}</small>
      </span>
      {selected && <span className="poster-reference-change">{t("更换")}</span>}
    </button>
    {selected && <button type="button" className="image-edit-close" disabled={disabled}
      onClick={() => onChange(null)} aria-label={t("移除爆款参考图")}>
      <CloseIcon />
    </button>}
    {open && <PosterLibraryDialog selected={selected} onClose={() => setOpen(false)} onPick={(poster) => {
      setOpen(false);
      onChange(poster);
    }} />}
  </div>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="m6 6 12 12M6 18 18 6" />
  </svg>;
}

function PosterLibraryDialog({ selected, onClose, onPick }: {
  selected: PosterSelection | null;
  onClose: () => void;
  onPick: (poster: PosterSelection) => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [categories, setCategories] = useState<string[] | null>(null);
  const [category, setCategory] = useState(selected?.category ?? "");
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const active = categories?.includes(category) ? category : categories?.[0];

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void api.posterCategories(controller.signal).then(
      (result) => { if (!controller.signal.aborted) setCategories(result.categories); },
      () => { if (!controller.signal.aborted) setError(true); },
    );
    return () => controller.abort();
  }, [attempt]);

  return <dialog ref={dialog} className="image-edit-dialog poster-library-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="image-edit-head">
      <h2 id={titleId}>{t("选择爆款")}</h2>
      <button type="button" className="image-edit-close" onClick={onClose} aria-label={t("关闭")} autoFocus><CloseIcon /></button>
    </header>
    {error ? <PosterLoadError onRetry={() => setAttempt((count) => count + 1)} />
      : categories === null ? <p className="poster-library-status" role="status">{t("读取中…")}</p>
        : !categories.length ? <p className="poster-library-status" role="status">{t("暂无爆款参考图")}</p>
          : <div className="poster-library-categories" role="group" aria-label={t("分类")}>
            {categories.map((name) => <button type="button" key={name} aria-pressed={active === name} onClick={() => setCategory(name)}>
              {t(name)}
            </button>)}
          </div>}
    {active && <PosterGallery key={active} category={active} selectedUrl={selected?.url} onPick={onPick} />}
  </dialog>;
}

function PosterLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return <div className="poster-library-status">
    <span role="status">{t("爆款参考图暂时无法读取")}</span>
    <button type="button" className="poster-library-more" onClick={onRetry}>{t("重试")}</button>
  </div>;
}

function PosterGallery({ category, selectedUrl, onPick }: {
  category: string;
  selectedUrl?: string;
  onPick: (poster: PosterSelection) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<PosterLibraryImage[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    void api.posterImages(category, offset, controller.signal).then(({ items: page, nextOffset: next }) => {
      if (controller.signal.aborted) return;
      setItems((current) => offset > 0 ? [...current, ...page] : page);
      setNextOffset(next);
      setStatus("ready");
    }, () => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [category, offset, attempt]);

  return <div className="poster-library-gallery" aria-busy={status === "loading"}>
    <div className="poster-library-grid">
      {items.map((poster) => <PosterTile key={poster.url} poster={poster} selected={poster.url === selectedUrl} onPick={onPick} />)}
    </div>
    {status === "error" && <PosterLoadError onRetry={() => setAttempt((count) => count + 1)} />}
    {status === "loading" && <p className="poster-library-status" role="status">{t("读取中…")}</p>}
    {status === "ready" && !items.length && <p className="poster-library-status" role="status">{t("此分类暂无爆款参考图")}</p>}
    {status === "ready" && nextOffset !== null && <button type="button" className="poster-library-more"
      onClick={() => setOffset(nextOffset)}>{t("加载更多")}</button>}
  </div>;
}

function PosterTile({ poster, selected, onPick }: {
  poster: PosterLibraryImage;
  selected: boolean;
  onPick: (poster: PosterSelection) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const image = useRef<HTMLImageElement>(null);
  return <button type="button" className="poster-library-tile" disabled={status !== "ready"} aria-pressed={selected}
    title={poster.name} onClick={() => {
      if (!image.current) return;
      onPick({ ...poster, ratio: nearestImageRatio(image.current.naturalWidth, image.current.naturalHeight) });
    }}>
    <span className="poster-library-image">
      {status === "error" ? t("图片加载失败") : <img ref={image} src={poster.url} alt="" loading="lazy" decoding="async"
        onLoad={() => setStatus("ready")} onError={() => setStatus("error")} />}
    </span>
    <span className="poster-library-name">{poster.name}</span>
  </button>;
}
