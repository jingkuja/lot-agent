import { useEffect, useState } from "react";
import type {
  ComicDrama, ComicDramaEpisodeBrief, ComicDramaSeriesStatus, ComicDramaTreeEntry, ComicDramaTreeListing,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { LibraryDialog, MediaPreview } from "./LibraryParts.js";
import { comicDramaApi } from "./api.js";

type EpisodeEntry = ComicDramaEpisodeBrief;
const statusLabels: Record<ComicDramaSeriesStatus, string> = {
  draft: "草稿",
  in_progress: "制作中",
  exported: "已导出",
};

export function SeriesHistory({
  busy, refreshToken = 0, focusDramaId, open, derive, change, onCreateDrama, onEditDrama, onAddEpisode, onDramaChange,
}: {
  busy: boolean;
  refreshToken?: number;
  focusDramaId?: string | null;
  open: (id: string) => void;
  derive: (id: string, action: "copy" | "sequel", inherit?: boolean) => Promise<boolean>;
  change: (entry: EpisodeEntry, action: "archive" | "remove") => Promise<boolean>;
  onCreateDrama?: () => void;
  onEditDrama?: (drama: ComicDrama) => void;
  onAddEpisode?: (drama: ComicDramaTreeEntry) => void;
  onDramaChange?: (drama: ComicDramaTreeEntry, action: "archive" | "remove") => Promise<boolean>;
}) {
  const { t, locale } = useI18n();
  const [result, setResult] = useState<ComicDramaTreeListing | null>(null);
  const [failure, setFailure] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | ComicDramaSeriesStatus>("");
  const [archived, setArchived] = useState(false);
  const [cursors, setCursors] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [sequel, setSequel] = useState<EpisodeEntry | null>(null);
  const cursor = cursors.at(-1);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ query: search, archived: String(archived) });
    if (statusFilter) params.set("status", statusFilter);
    if (cursor) params.set("cursor", cursor);
    setResult(null);
    setFailure(false);
    void comicDramaApi.listDramas(params, controller.signal).then(data => {
      if (!controller.signal.aborted) setResult(data);
    }).catch(() => { if (!controller.signal.aborted) setFailure(true); });
    return () => controller.abort();
  }, [archived, cursor, refresh, refreshToken, search, statusFilter]);
  const update = async (entry: EpisodeEntry, action: "archive" | "remove") => {
    if (await change(entry, action)) setRefresh(value => value + 1);
  };
  const updateDrama = async (drama: ComicDramaTreeEntry, action: "archive" | "remove") => {
    if (onDramaChange && await onDramaChange(drama, action)) setRefresh(value => value + 1);
  };
  return <>
    <header className="comic-heading">
      <h1>{t("历史剧集")}</h1>
      {onCreateDrama && (
        <div className="comic-actions">
          <button type="button" className="primary" disabled={busy} onClick={onCreateDrama}>
            ＋ {t("新建整部剧集")}
          </button>
        </div>
      )}
    </header>
    <form className="comic-history-controls" onSubmit={event => { event.preventDefault(); setCursors([]); setSearch(query.trim()); }}>
      <input aria-label={t("搜索剧集")} placeholder={t("搜索剧集")} maxLength={120} value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label={t("剧集状态")} value={statusFilter} onChange={event => {
        setStatusFilter(event.target.value as "" | ComicDramaSeriesStatus); setCursors([]);
      }}>
        <option value="">{t("全部状态")}</option>
        <option value="draft">{t("草稿")}</option>
        <option value="in_progress">{t("制作中")}</option>
        <option value="exported">{t("已导出")}</option>
      </select>
      <button type="submit">{t("搜索")}</button>
      {(search || query || statusFilter) && <button type="button" onClick={() => {
        setQuery(""); setSearch(""); setStatusFilter(""); setCursors([]);
      }}>{t("清除筛选")}</button>}
      <label><input type="checkbox" checked={archived} onChange={event => { setArchived(event.target.checked); setCursors([]); }} />{t("已归档")}</label>
    </form>
    {failure && <p role="alert">{t("剧集暂时无法读取")} <button type="button" onClick={() => setRefresh(value => value + 1)}>{t("重试")}</button></p>}
    {!result && !failure && <p role="status">{t("加载中…")}</p>}
    {result && result.dramas.length === 0 && <div className="comic-empty"><p>{t(search || statusFilter ? "没有匹配的剧集" : "暂无剧集")}</p></div>}
    {result && result.dramas.length > 0 && <div className="comic-drama-tree">
      {result.dramas.map(drama => (
        <section
          key={drama.id}
          className="comic-drama-group"
          data-current={focusDramaId === drama.id ? "true" : undefined}
        >
          <header className="comic-drama-group-head">
            <div className="comic-drama-group-meta">
              <div className="comic-cut-badges">
                <span className="comic-hierarchy-level">{t("整部剧集")}</span>
                <small className="comic-pill" data-tone={drama.status === "exported" ? "done" : drama.status === "in_progress" ? "busy" : "idle"}>
                  {t(statusLabels[drama.status])}
                </small>
                <small className="comic-pill" data-tone="frame">{t("共 {0} 集", [drama.episodeCount])}</small>
                <small className="comic-pill" data-tone="idle">{t("{0} 个分镜", [drama.clipCount])}</small>
              </div>
              <h2>{drama.title}</h2>
              {drama.synopsis && <p>{drama.synopsis}</p>}
            </div>
            <div className="comic-actions">
              {!drama.archivedAt && onAddEpisode && (
                <button type="button" className="primary" disabled={busy} onClick={() => onAddEpisode(drama)}>
                  ＋ {t("新增分集")}
                </button>
              )}
              {!drama.archivedAt && onEditDrama && (
                <button type="button" disabled={busy} onClick={() => onEditDrama(drama)}>{t("编辑整部剧集")}</button>
              )}
              {!drama.archivedAt && onDramaChange && (
                <button type="button" disabled={busy} onClick={() => void updateDrama(drama, "archive")}>{t("归档整部剧集")}</button>
              )}
              {onDramaChange && (
                <button type="button" disabled={busy} onClick={() => void updateDrama(drama, "remove")}>{t("删除整部剧集")}</button>
              )}
            </div>
          </header>
          {drama.episodes.length === 0 ? (
            <p className="comic-generation-note">{t("该剧集下暂无分集")}</p>
          ) : (
            <div className="comic-library-grid comic-series-grid">
              {drama.episodes.map(entry => {
                const st: ComicDramaSeriesStatus = entry.status;
                return (
                  <article className="comic-library-card comic-series-card" key={entry.id}>
                    {entry.coverMediaId ? (
                      <MediaPreview media={{ id: entry.coverMediaId, hasThumbnail: true, durationMs: null }} title={entry.title} thumbOnly />
                    ) : (
                      <div className="comic-media-well comic-character-initial" aria-hidden="true">{Array.from(entry.title)[0] ?? "剧"}</div>
                    )}
                    <div className="comic-cut-badges">
                      <small className="comic-pill" data-tone="frame">{t("第 {0} 集", [entry.episodeNo])}</small>
                      <small className="comic-pill" data-tone={st === "exported" ? "done" : st === "in_progress" ? "busy" : "idle"}>
                        {t(statusLabels[st])}
                      </small>
                    </div>
                    <button type="button" className="comic-history-title" onClick={() => open(entry.id)} disabled={busy}>
                      <strong>{entry.title}</strong>
                      <small>
                        {t("{0} 个分镜", [entry.clipCount])}
                        {" · "}{t("已完成 {0}/{1}", [entry.completedCount, entry.clipCount])}
                        {entry.generatingCount > 0 ? <> · {t("生成中 {0}", [entry.generatingCount])}</> : null}
                        {" · "}{new Date(entry.updatedAt).toLocaleDateString(locale)}
                      </small>
                    </button>
                    <div className="comic-actions">
                      {!entry.archivedAt && <>
                        <button type="button" disabled={busy} onClick={() => void derive(entry.id, "copy")}>{t("复制剧集")}</button>
                        <button type="button" disabled={busy} onClick={() => setSequel(entry)}>{t("续写下一集")}</button>
                        <button type="button" disabled={busy} onClick={() => void update(entry, "archive")}>{t("归档")}</button>
                      </>}
                      <button type="button" disabled={busy} onClick={() => void update(entry, "remove")}>{t("删除")}</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ))}
    </div>}
    {sequel && <LibraryDialog title={t("续写下一集")} submitLabel={t("创建并打开")} close={() => setSequel(null)} save={async form => {
      if (!await derive(sequel.id, "sequel", form.get("inherit") === "on")) throw new Error("Sequel could not be created");
    }}>
      <p>{sequel.title}</p>
      <label className="comic-sequel-option"><input type="checkbox" name="inherit" defaultChecked />{t("沿用上一集的角色与画风")}</label>
    </LibraryDialog>}
    {(!!cursor || !!result?.nextCursor) && <div className="comic-actions">
      <button type="button" disabled={!cursor} onClick={() => setCursors(value => value.slice(0, -1))}>{t("上一页")}</button>
      <button type="button" disabled={!result?.nextCursor} onClick={() => {
        if (result?.nextCursor) setCursors(value => [...value, result.nextCursor!]);
      }}>{t("下一页")}</button>
    </div>}
  </>;
}
