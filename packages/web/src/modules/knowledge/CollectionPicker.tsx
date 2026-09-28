import { useI18n } from "../../i18n/index.js";
import { useEffect, useId, useRef, useState } from "react";
import type { Collection } from "./api.js";

export function CollectionPicker({ collections, disabled, onSelect, onLoadMore, loadExcludedIds }: {
  collections: Collection[];
  disabled?: boolean;
  onSelect: (id: string) => void;
  onLoadMore?: () => Promise<void>;
  loadExcludedIds?: () => Promise<string[]>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  async function toggle() {
    if (open) { setOpen(false); return; }
    setQuery("");
    setError("");
    setOpen(true);
    if (!loadExcludedIds) return;
    const id = ++requestId.current;
    setPreparing(true);
    try {
      const ids = await loadExcludedIds();
      if (id === requestId.current) setExcludedIds(ids);
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : "无法加载知识库，请重新打开重试。");
    } finally {
      if (id === requestId.current) setPreparing(false);
    }
  }
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const available = collections.filter((c) => !excludedIds.includes(c.id));
  const filtered = available.filter((c) => c.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="knowledge-collection-picker" ref={root}>
    <button type="button" ref={trigger} disabled={disabled} aria-expanded={open && !disabled} aria-controls={popupId} onClick={() => void toggle()}>
      {t("加入知识库")}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && !disabled && <div id={popupId} className="knowledge-collection-popup" role="group" aria-label={t("选择要加入的知识库")}>
      <input autoFocus aria-label={t("搜索知识库")} placeholder={t("搜索知识库…")} value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="model-list">
        {preparing ? <div className="model-empty" role="status">{t("正在加载知识库…")}</div> : error ? <div className="model-empty" role="alert">{t(error)}</div> : <>
        {filtered.map((c) => <button type="button" className="model-row" key={c.id} onClick={() => { setOpen(false); trigger.current?.focus(); onSelect(c.id); }}><span className="model-row-name">{c.name}</span>{c.description && <span className="model-row-desc">{c.description}</span>}</button>)}
        {!filtered.length && <div className="model-empty">{available.length ? t("无匹配知识库") : t("暂无可加入的知识库")}</div>}
        {onLoadMore && <button type="button" disabled={loading} onClick={async () => { setLoading(true); try { await onLoadMore(); } finally { setLoading(false); } }}>{loading ? t("正在加载…") : t("加载更多知识库")}</button>}
        </>}
      </div>
    </div>}
  </div>;
}
