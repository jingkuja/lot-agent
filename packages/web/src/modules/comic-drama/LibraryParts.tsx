import { useEffect, useRef, useState, type FormEvent, type ReactNode, type SelectHTMLAttributes } from "react";
import { comicSystemDictionary, type ComicDictionaryDomain, type ComicDictionaryEntry, type ComicMedia, type ComicMediaLinks, type ComicMediaVersion } from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";

export const comicListWords = (value: string) => [...new Set(value.split(/[,，]/).map(word => word.trim()).filter(Boolean))];

const errors: Record<string, string> = {
  INVALID_INPUT: "请检查字段内容及长度",
  INVALID_CATEGORY: "此字典条目已停用或不可用",
  DICTIONARY_KEY_EXISTS: "该键已存在",
  MEDIA_UNAVAILABLE: "私有素材服务未配置",
  MEDIA_TOO_LARGE: "文件超过大小限制",
  MEDIA_TOO_LONG: "音频超过时长限制",
  UNSUPPORTED_MEDIA: "文件格式不支持或内容损坏",
  NOT_FOUND: "素材或角色不存在",
  FRAME_OUT_OF_RANGE: "截帧时间超出视频范围",
  FRAME_UNAVAILABLE: "无法读取此时间点的画面",
};
export function libraryError(error: unknown) {
  return error instanceof ApiClientError && error.code ? errors[error.code] ?? "操作失败，请重试" : "操作失败，请重试";
}

export function useComicChoices(domain: ComicDictionaryDomain, refresh = 0) {
  const [items, setItems] = useState<{ domain: ComicDictionaryDomain; entries: Awaited<ReturnType<typeof comicLibraryApi.dictionary>> }>();
  useEffect(() => {
    const controller = new AbortController();
    void comicLibraryApi.dictionary(domain, controller.signal).then(entries => {
      if (!controller.signal.aborted) setItems({ domain, entries });
    }).catch(() => {});
    return () => controller.abort();
  }, [domain, refresh]);
  return items?.domain === domain ? items.entries : comicSystemDictionary[domain];
}

type ChoiceProps = SelectHTMLAttributes<HTMLSelectElement> & { existing?: string | null; empty?: string };

export function ChoiceSelect({ domain, ...props }: ChoiceProps & { domain: ComicDictionaryDomain }) {
  return <DictionaryOptions choices={useComicChoices(domain)} {...props} />;
}

export function DictionaryOptions({ choices, existing, empty, ...props }: ChoiceProps & { choices: readonly ComicDictionaryEntry[] }) {
  const { locale } = useI18n();
  return <select {...props}>
    {empty !== undefined && <option value="">{empty}</option>}
    {existing && !choices.some(entry => entry.key === existing) && <option value={existing}>{existing}</option>}
    {choices.filter(entry => !entry.inactive || entry.key === existing).map(entry =>
      <option key={entry.key} value={entry.key}>{entry.labels[locale]}</option>)}
  </select>;
}

export function MediaPreview({ media, title, thumbOnly = false, openOriginal = false }: {
  media: Pick<ComicMedia, "id" | "hasThumbnail" | "durationMs">; title: string; thumbOnly?: boolean; openOriginal?: boolean;
}) {
  const { t } = useI18n();
  const [attempt, remake] = useState(0);
  const [state, setState] = useState<ComicMediaLinks | "error" | null>(null);
  const recovered = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    void comicLibraryApi.links(media.id, controller.signal).then(links => {
      if (!controller.signal.aborted) setState(links);
    }).catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [media.id, attempt]);
  const failure = () => {
    if (recovered.current) { setState("error"); return; }
    recovered.current = true;
    remake(i => i + 1);
  };
  if (state === "error") return <button type="button" onClick={() => {
    recovered.current = false;
    remake(i => i + 1);
  }}>{t("重新获取预览")}</button>;
  if (!state) return <div className="comic-media-well" aria-label={t("加载中…")} />;
  if (media.hasThumbnail) {
    const image = <img src={state.thumbnailUrl ?? undefined} alt={title} loading="lazy" onLoad={() => { recovered.current = false; }} onError={failure} />;
    return openOriginal
      ? <a href={state.url} target="_blank" rel="noreferrer" aria-label={t("查看原图")} className="comic-media-well">{image}</a>
      : <div className="comic-media-well">{image}</div>;
  }
  if (thumbOnly) return null;
  return <div className="comic-audio">
    <audio controls preload="none" src={state.url} aria-label={title}
      onLoadedMetadata={() => { recovered.current = false; }} onError={failure} />
    {media.durationMs && <small>{(media.durationMs / 1000).toFixed(1)} s</small>}
  </div>;
}

export function LibraryDialog({ title, submitLabel, close, save, children, describeError = libraryError }: {
  title: string; submitLabel: string; close: () => void;
  save: (form: FormData, signal: AbortSignal) => Promise<unknown>; children: ReactNode; describeError?: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const running = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => { ref.current?.showModal(); return () => running.current?.abort(); }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running.current) return;
    const form = new FormData(event.currentTarget);
    const controller = new AbortController();
    running.current = controller;
    setSaving(true);
    setFailure("");
    try { await save(form, controller.signal); if (!controller.signal.aborted) close(); }
    catch (error) { if (!controller.signal.aborted) setFailure(describeError(error)); }
    finally { running.current = null; if (!controller.signal.aborted) setSaving(false); }
  };
  return <dialog className="comic-dialog" ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={submit}>
      <h2>{title}</h2>
      <fieldset disabled={saving}>{children}</fieldset>
      {failure && <p className="comic-error" role="alert">{t(failure)}</p>}
      <div className="comic-actions comic-dialog-actions">
        <button type="button" onClick={close}>{t("取消")}</button>
        <button className="primary" disabled={saving}>{saving ? t("保存中…") : submitLabel}</button>
      </div>
    </form>
  </dialog>;
}

export function MediaVersions({ list, close }: { list: (signal: AbortSignal) => Promise<ComicMediaVersion[]>; close: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<ComicMediaVersion[] | "error" | null>(null);
  const [attempt, reload] = useState(0);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setRows(null);
    void list(controller.signal).then(result => {
      if (!controller.signal.aborted) setRows(result);
    }).catch(() => { if (!controller.signal.aborted) setRows("error"); });
    return () => controller.abort();
  }, [list, attempt]);
  return <dialog className="comic-dialog" ref={ref} aria-label={t("版本历史")} onCancel={event => { event.preventDefault(); close(); }}>
    <h2>{t("版本历史")}</h2>
    {rows === "error" ? <button type="button" onClick={() => reload(i => i + 1)}>{t("重试")}</button> :
      rows ? <div className="comic-version-list">{rows.map(entry => <article key={entry.media.id}>
        <strong>{t("版本 {0}", [entry.version])}</strong>
        <MediaPreview media={entry.media} title={t("版本 {0}", [entry.version])} />
        <button type="button" onClick={() => {
          const tab = window.open("about:blank", "_blank");
          if (tab) {
            tab.opener = null;
            void comicLibraryApi.links(entry.media.id).then(links => { tab.location.href = links.url; }).catch(() => tab.close());
          }
        }}>{t("查看原件")}</button>
      </article>)}</div> : <p role="status">{t("加载中…")}</p>}
    <div className="comic-actions comic-dialog-actions"><button type="button" onClick={close}>{t("关闭")}</button></div>
  </dialog>;
}

export function LibraryPagination({ page, more, change }: { page: number; more: boolean; change: (page: number) => void }) {
  const { t } = useI18n();
  if (page === 1 && !more) return null;
  return <div className="comic-actions comic-library-pagination">
    <button type="button" disabled={page === 1} onClick={() => change(page - 1)}>{t("上一页")}</button>
    <button type="button" disabled={!more} onClick={() => change(page + 1)}>{t("下一页")}</button>
  </div>;
}

export function LibrarySearch({ query, search, archived, onArchived }: {
  query: string; search: (value: string) => void; archived: boolean; onArchived: (value: boolean) => void;
}) {
  const { t } = useI18n();
  return <form className="comic-history-controls" onSubmit={event => {
    event.preventDefault();
    search(String(new FormData(event.currentTarget).get("query") ?? "").trim());
  }}>
    <input key={query} aria-label={t("搜索名称或标签")} name="query" defaultValue={query} maxLength={120} placeholder={t("搜索名称或标签")} />
    <button>{t("搜索")}</button>
    <label><input type="checkbox" checked={archived} onChange={event => onArchived(event.target.checked)} />{t("已归档")}</label>
  </form>;
}
