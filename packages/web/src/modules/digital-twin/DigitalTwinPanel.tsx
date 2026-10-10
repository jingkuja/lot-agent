import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../i18n/index.js";
import { knowledgeApi, type Item } from "../knowledge/api.js";
import { TwinCapture } from "./TwinCapture.js";
import { twinTag, type TwinKind } from "./media.js";
import "../knowledge/knowledge.css";
import "./digital-twin.css";

export type SelectTwin = (file: File, kind: TwinKind) => Promise<void>;

function TwinAsset({ item, kind, onRemove, onSelect }: { item: Item; kind: TwinKind; onRemove: () => Promise<void>; onSelect?: SelectTwin }) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const abort = new AbortController(); let objectUrl = "";
    setFile(null); setUrl(""); setError("");
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void knowledgeApi.file(item, abort.signal).then((value) => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(value); setFile(value); setUrl(objectUrl);
      }).catch(() => { if (!abort.signal.aborted) setError("素材加载失败，请重试。"); });
    }, { rootMargin: "200px" });
    if (card.current) observer.observe(card.current);
    return () => { observer.disconnect(); abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item.id, item.revisionId, attempt]);
  async function act(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败，请重试。"); }
    finally { lock.current = false; setBusy(false); }
  }
  return <article ref={card} className="twin-asset">
    <div className={`twin-asset-preview twin-asset-preview--${kind}`}>
      {url ? kind === "voice" ? <audio src={url} controls preload="metadata" aria-label={item.title} /> : <img src={url} alt={item.title} loading="lazy" /> : <span>{t(error ? "预览不可用" : "正在加载…")}</span>}
    </div>
    <strong title={item.title}>{item.title}</strong>
    <small>{(item.size / 1024 / 1024).toFixed(2)} MB</small>
    <div className="twin-actions">
      {onSelect && <button type="button" disabled={busy || !file} onClick={() => void act(() => onSelect(file!, kind))}>{t("用于视频制作")}</button>}
      {!file && error && <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t("重试")}</button>}
      <button type="button" disabled={busy} onClick={() => { if (window.confirm(t("删除分身素材“{0}”？", [item.title]))) void act(onRemove); }}>{t("删除")}</button>
    </div>
    {error && <p className="twin-error" role="alert">{t(error)}</p>}
  </article>;
}

function TwinLibrary({ kind, onSelect, onChanged }: { kind: TwinKind; onSelect?: SelectTwin; onChanged?: () => Promise<void> }) {
  const { t } = useI18n();
  const id = useId();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const requestId = useRef(0);
  const load = useCallback(async (next?: string) => {
    const request = ++requestId.current;
    setLoading(true); setError("");
    try {
      const page = await knowledgeApi.items("all", next, kind === "voice" ? "audio" : "image", twinTag(kind));
      if (!mounted.current || request !== requestId.current) return;
      setItems((old) => next ? [...old, ...page.data.filter((item) => !old.some((existing) => existing.id === item.id))] : page.data);
      setCursor(page.nextCursor);
    } catch (e) { if (mounted.current && request === requestId.current) setError(e instanceof Error ? e.message : "素材加载失败，请重试。"); }
    finally { if (mounted.current && request === requestId.current) setLoading(false); }
  }, [kind]);
  const changed = async () => { await load(); await onChanged?.(); };
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; requestId.current++; }; }, [load]);
  return <section className="twin-library" aria-labelledby={id}>
    <header><span className="twin-library-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{kind === "voice" ? <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8" /></> : <><circle cx="12" cy="8" r="4" /><path d="M4 22v-2a8 8 0 0 1 16 0v2 M3 5V2h3 M18 2h3v3" /></>}</svg></span><div><h4 id={id}>{t(kind === "voice" ? "个人语音库" : "个人肖像库")}</h4><p>{t(kind === "voice" ? "录制或上传清晰的人声样例，让视频参考你的音色。" : "拍照或上传清晰肖像，作为视频中的人物形象参考。")}</p></div></header>
    <p className="twin-spec">{t(kind === "voice" ? "MP3 / WAV · 2–15 秒 · 最大 15 MB；建议在安静环境中自然朗读。" : "JPG / PNG / WebP · 最大 20 MB；建议正面、光线充足、面部无遮挡。")}</p>
    <TwinCapture kind={kind} onSaved={changed} />
    {error && <p className="twin-error" role="alert">{t(error)} <button type="button" disabled={loading} onClick={() => void load()}>{t("重试")}</button></p>}
    {loading && <p role="status">{t("正在加载…")}</p>}
    {!loading && !error && !items.length && <div className="twin-empty">{t(kind === "voice" ? "还没有声音样例，录制第一段个人声音吧。" : "还没有肖像，拍摄或上传第一张照片吧。")}</div>}
    <div className="twin-assets">{items.map((item) => <TwinAsset key={item.id} item={item} kind={kind} onSelect={onSelect} onRemove={async () => { await knowledgeApi.remove(item); await changed(); }} />)}</div>
    {cursor && <button type="button" disabled={loading} onClick={() => void load(cursor)}>{t("加载更多")}</button>}
  </section>;
}

export function DigitalTwinPanel({ onSelect, onChanged }: { onSelect?: SelectTwin; onChanged?: () => Promise<void> }) {
  const { t } = useI18n();
  return <div className="digital-twin-panel">
    <div className="knowledge-section-heading"><h3>{t("数字分身")}</h3><p>{t("保存你的声音和肖像，在视频制作中随时选用。")}</p></div>
    <div className="twin-libraries"><TwinLibrary kind="voice" onSelect={onSelect} onChanged={onChanged} /><TwinLibrary kind="portrait" onSelect={onSelect} onChanged={onChanged} /></div>
    <p className="twin-footnote">{t("在视频制作输入框中点击“数字分身”即可选用素材。音色与肖像还原效果，以及真人肖像是否可用，取决于所选模型。")}</p>
  </div>;
}

export function DigitalTwinPicker({ onSelect, onClose }: { onSelect: SelectTwin; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="knowledge-dialog twin-picker" aria-label={t("选择数字分身素材")} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <header className="knowledge-head knowledge-header"><h2>{t("选择数字分身素材")}</h2><button type="button" onClick={onClose}>{t("完成")}</button></header>
    <main className="knowledge-main"><DigitalTwinPanel onSelect={async (file, kind) => { await onSelect(file, kind); setNotice(t("已添加“{0}”，可继续选择其他素材。", [file.name])); }} /></main>
    {notice && <p className="twin-selection-notice" role="status">{notice}</p>}
  </dialog>;
}
