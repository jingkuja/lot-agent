import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n/index.js";
import { knowledgeApi, type Material } from "../modules/knowledge/api.js";
import { COMPOSE_LAYOUTS, COMPOSE_MAX_IMAGES, COMPOSE_MIN_IMAGES, type ComposeLayout } from "../lib/image-settings.js";

export type ComposeImagesHandler = (urls: string[], layout: ComposeLayout, gap: boolean, prompt: string) => Promise<string | undefined>;

interface Props {
  /** Images made in this conversation, newest first. */
  conversationImages: string[];
  onCompose: ComposeImagesHandler;
  onClose: () => void;
}

/** One picked-or-not picture; the number is its place in the joined image. */
function PickTile({ url, order, full, onToggle }: { url: string; order: number; full: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const picked = order > 0;
  return (
    <button type="button" className={`image-compose-tile${picked ? " picked" : ""}${loaded ? " loaded" : ""}`}
      aria-pressed={picked} disabled={failed || (!picked && full)} onClick={onToggle}
      title={failed ? t("图片加载失败") : !picked && full ? t("最多选择 {0} 张", [COMPOSE_MAX_IMAGES]) : undefined}>
      {failed ? <span className="image-compose-tile-failed">{t("图片加载失败")}</span>
        : <img src={url} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
      <span className="image-compose-check" aria-hidden>{picked ? order : ""}</span>
    </button>
  );
}

/** 图片合成 from the composer: pick images from this conversation and from 个人素材 (generated only), then join them. */
export function ImageComposeDialog({ conversationImages, onCompose, onClose }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const [layout, setLayout] = useState<ComposeLayout>(COMPOSE_LAYOUTS[0].value);
  const [gap, setGap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<Material[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [libraryError, setLibraryError] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  /** Next page of generated images from 个人素材, newest first. */
  const loadMore = async () => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    setLibraryError(false);
    const last = library[library.length - 1];
    try {
      const { data } = await knowledgeApi.materials(last?.cursor_time, last?.id, "image", "generated");
      setLibrary((old) => [...old, ...data]);
      if (!data.length) setDone(true);
    } catch {
      setLibraryError(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  // Load the next page when the end of the list scrolls into view. Observing again after each page also covers a page
  // that added nothing new to show (every image already listed above), since a new observation reports at once.
  useEffect(() => {
    if (!libraryOpen || done || libraryError || !sentinel.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root: sentinel.current.closest(".image-compose-body"), rootMargin: "200px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [libraryOpen, done, libraryError, library.length]);

  const inConversation = new Set(conversationImages);
  const libraryImages = [...new Set(library.map((item) => item.url).filter((url) => url && !inConversation.has(url)))];
  const full = picked.length >= COMPOSE_MAX_IMAGES;
  const toggle = (url: string) => {
    setError(undefined);
    setPicked((old) => old.includes(url) ? old.filter((item) => item !== url) : old.length >= COMPOSE_MAX_IMAGES ? old : [...old, url]);
  };
  const layouts = COMPOSE_LAYOUTS.filter((item) => Math.max(picked.length, COMPOSE_MIN_IMAGES) >= item.min);
  const active = layouts.find((item) => item.value === layout) ?? layouts[0];
  const ready = picked.length >= COMPOSE_MIN_IMAGES && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    const name = gap ? `${t(active.label)} · ${t("留白")}` : t(active.label);
    let failure: string | undefined;
    try {
      failure = await onCompose(picked, active.value, gap, t("合成 {0} 张图片 · {1}", [picked.length, name]));
    } catch {
      failure = "合成失败，请稍后重试";
    }
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };

  const tiles = (urls: string[]) => (
    <div className="image-compose-grid">
      {urls.map((url) => (
        <PickTile key={url} url={url} order={picked.indexOf(url) + 1} full={full} onToggle={() => toggle(url)} />
      ))}
    </div>
  );

  return (
    <dialog ref={dialog} className="image-edit-dialog image-compose" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="image-edit-head">
        <h2 id={titleId}>{t("图片合成")}</h2>
        <button type="button" className="image-edit-close" onClick={onClose} disabled={busy} aria-label={t("关闭")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <p className="image-compose-hint">
        {t("选择 {0}–{1} 张图片，按点选顺序合成为一张。", [COMPOSE_MIN_IMAGES, COMPOSE_MAX_IMAGES])}
      </p>
      <div className="image-compose-body">
        <section className="image-compose-section">
          <h3>{t("本对话生成的图片")}</h3>
          {conversationImages.length ? tiles(conversationImages)
            : <p className="image-compose-empty">{t("本对话还没有生成图片，可以从下方个人素材库选择")}</p>}
        </section>
        <section className="image-compose-section">
          <button type="button" className="image-compose-section-toggle" aria-expanded={libraryOpen}
            onClick={() => setLibraryOpen((open) => !open)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m9 6 6 6-6 6" />
            </svg>
            <strong>{t("个人素材库")}</strong>
            <span>{t("模型生成的图片，按生成时间从新到旧")}</span>
          </button>
          {libraryOpen && (
            <>
              {libraryImages.length > 0 && tiles(libraryImages)}
              {done && !libraryImages.length && <p className="image-compose-empty">{t("个人素材库里还没有其他生成的图片")}</p>}
              {libraryError && (
                <p className="image-compose-empty">
                  {t("个人素材暂时读取不到")}{" "}
                  <button type="button" className="image-compose-retry" onClick={() => void loadMore()}>{t("重试")}</button>
                </p>
              )}
              {loading && <p className="image-compose-empty">{t("读取中…")}</p>}
              {!done && !libraryError && <div ref={sentinel} className="image-compose-sentinel" aria-hidden />}
            </>
          )}
        </section>
      </div>
      <footer className="image-compose-footer">
        <div className="gen-compose-layouts" role="radiogroup" aria-label={t("合成版式")}>
          {layouts.map((item) => (
            <button key={item.value} type="button" role="radio" aria-checked={item.value === active.value}
              className={`gen-compose-layout${item.value === active.value ? " active" : ""}`} onClick={() => setLayout(item.value)}>
              {t(item.label)}
            </button>
          ))}
          <label className="gen-compose-gap">
            <input type="checkbox" checked={gap} onChange={(event) => setGap(event.target.checked)} />
            {t("图片之间留白")}
          </label>
        </div>
        <p className="gen-compose-hint">
          {t(active.hint)}{active.value !== "vertical" ? t("；按第一张图的比例排列，比例不同的图会被裁切") : ""}
        </p>
        <div className="gen-compose-actions">
          <button type="button" className="gen-compose-submit" onClick={submit} disabled={!ready}>
            {busy ? t("合成中…") : t("合成 {0} 张", [picked.length])}
          </button>
          <span className="gen-compose-free">{t("合成不扣积分")}</span>
          {picked.length > 0 && !busy && (
            <button type="button" className="image-compose-clear" onClick={() => setPicked([])}>{t("清空选择")}</button>
          )}
        </div>
        {error && <p className="gen-compose-error" role="alert">{t(error)}</p>}
      </footer>
      {/* Covers the picker while the server joins the images and the picture downloads; nothing can be changed mid-way. */}
      {busy && (
        <div className="gen-set-busy image-compose-busy" role="status" aria-live="polite">
          <span className="gen-set-spinner" aria-hidden />{t("正在合成…")}
        </div>
      )}
    </dialog>
  );
}
