import { useEffect, useId, useState } from "react";
import type { ComicGenerationPreviewRequest, ComicMaterial } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";

type Reference = NonNullable<ComicGenerationPreviewRequest["visualReferences"]>[number];
export type ChosenVideoReference = Reference & { name: string; version: number };
const labels = { style: "画风", scene: "场景", prop: "道具" } as const;

export function ComicVideoReferences({ references, change }: {
  references: ChosenVideoReference[]; change: (items: ChosenVideoReference[]) => void;
}) {
  const { t } = useI18n();
  const selectId = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Reference["kind"]>("scene");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<ComicMaterial[] | "error" | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      setEntries(null);
      void comicLibraryApi.materials({ kind: kind === "style" ? "other" : kind, query }, controller.signal).then(result => {
        if (!controller.signal.aborted) setEntries(result.entries.filter(item => item.media.mime.startsWith("image/")));
      }).catch(() => { if (!controller.signal.aborted) setEntries("error"); });
    }, 180);
    return () => { clearTimeout(handle); controller.abort(); };
  }, [kind, open, query]);
  return <details className="comic-video-references" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("参考素材（{0}）", [references.length])}</summary>
    <div className="comic-clip-fields">
      <label>{t("参考类型")}<select value={kind} onChange={event => {
        setEntries(null);
        const next = event.target.value;
        if (next === "style" || next === "scene" || next === "prop") setKind(next);
      }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
      <label>{t("搜索名称或标签")}<input value={query} maxLength={120}
        onChange={event => { setEntries(null); setQuery(event.target.value); }} /></label>
      <label htmlFor={selectId}>{t("添加参考图")}</label>
      <select id={selectId} value="" disabled={references.length >= 10 || !Array.isArray(entries)} onChange={event => {
        const item = Array.isArray(entries) ? entries.find(item => item.id === event.target.value) : undefined;
        if (item) change([...references, { kind, materialId: item.id, mediaId: item.media.id, name: item.name, version: item.version }]);
      }}>
        <option value="">{t("请选择")}</option>
        {Array.isArray(entries) && entries.filter(item => !references.some(ref => ref.mediaId === item.media.id)).map(item =>
          <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      {entries === "error" && <p role="alert">{t("操作失败，请重试")}</p>}
      {Array.isArray(entries) && !entries.length && <p>{t("暂无匹配的素材")}</p>}
      {references.map(ref => <div className="comic-actions" key={ref.mediaId}>
        <small>{t(labels[ref.kind])} · {ref.name} · {t("版本 {0}", [ref.version])}</small>
        <button type="button" onClick={() => change(references.filter(item => item.mediaId !== ref.mediaId))}>{t("移除")}</button>
      </div>)}
    </div>
  </details>;
}
