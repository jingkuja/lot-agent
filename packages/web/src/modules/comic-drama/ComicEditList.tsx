import { useEffect, useState } from "react";
import type { ComicEditCreate, ComicEditList as Page, ComicEditListEntry } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicEditApi, editError } from "./edit-api.js";
import { LibraryDialog } from "./LibraryParts.js";

export function NewComicEdit({ seed, open, close }: { seed?: Pick<ComicEditCreate, "seriesId" | "takeId">; open: (id: string) => void; close: () => void }) {
  const { t } = useI18n();
  return <LibraryDialog title={t("新建剪辑工程")} submitLabel={t("创建工程")} close={close} describeError={editError} save={async (form, signal) => {
    const title = String(form.get("title") ?? "").trim();
    const project = await comicEditApi.create({ title, ...seed }, signal);
    if (!signal.aborted && seed?.seriesId && form.get("autoDialogue") === "on") {
      await comicEditApi.autoDialogue(project.id, {
        expectedRevision: project.revision, includeVoice: true, includeSubtitles: true,
      }, signal).catch(() => {});
    }
    if (!signal.aborted) open(project.id);
  }}>
    <label>{t("工程名称")}<input name="title" required autoFocus maxLength={120} /></label>
    {seed?.takeId && <p>{t("工程将锁定当前预览的片源版本。")}</p>}
    {seed?.seriesId && <>
      <p>{t("工程将按分镜顺序加入本集当前采用的版本。")}</p>
      <label className="comic-sequel-option">
        <input type="checkbox" name="autoDialogue" />
        {t("同时按分镜台词批量合成配音并铺字幕轨")}
      </label>
    </>}
  </LibraryDialog>;
}

export function ComicEditsIndex({ open, browse, currentSeries }: { open: (id: string) => void; browse: () => void; currentSeries?: string }) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState<Page | "error" | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [create, setCreate] = useState<"empty" | "series" | null>(null);
  const [error, setError] = useState("");
  const refresh = () => setAttempt(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    void comicEditApi.list(cursor, controller.signal).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch(() => { if (!controller.signal.aborted) setPage("error"); });
    return () => controller.abort();
  }, [cursor, attempt]);
  const remove = async (entry: ComicEditListEntry) => {
    if (!window.confirm(t("删除剪辑工程「{0}」？", [entry.title]))) return;
    setError("");
    try { await comicEditApi.remove(entry.id, entry.revision); refresh(); }
    catch (error) { setError(editError(error)); }
  };
  const lastEntry = page && page !== "error" && page.lastEditId ? page.entries.find(e => e.id === page.lastEditId) : undefined;
  return <>
    <header className="comic-heading"><h1>{t("剪辑工作台")}</h1><div className="comic-actions">
      {lastEntry && <button type="button" onClick={() => open(lastEntry.id)}>{t("继续上次剪辑")} · {lastEntry.title}</button>}
      <button onClick={browse}>{t("选择剪辑片源")}</button>
      {currentSeries && <button onClick={() => setCreate("series")}>{t("用本集采用版建工程")}</button>}
      <button className="primary" onClick={() => setCreate("empty")}>{t("新建剪辑工程")}</button>
    </div></header>
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    {page === "error" ? <button onClick={refresh}>{t("重新读取")}</button> : !page ? <p role="status">{t("加载中…")}</p> :
      page.entries.length === 0 ? <p className="comic-empty">{t("暂无剪辑工程")}</p> : <div className="comic-history-list">
        {page.entries.map(entry => <article key={entry.id}>
          <button type="button" onClick={() => open(entry.id)}>{entry.title}</button>
          <small>{new Date(entry.updatedAt).toLocaleString(locale)}</small>
          <button onClick={() => void remove(entry)}>{t("删除")}</button>
        </article>)}
      </div>}
    {page && page !== "error" && (cursor || page.nextCursor) && <div className="comic-actions">
      {cursor && <button onClick={() => setCursor(undefined)}>{t("第一页")}</button>}
      {page.nextCursor && <button onClick={() => setCursor(page.nextCursor ?? undefined)}>{t("下一页")}</button>}
    </div>}
    {create && <NewComicEdit open={open} close={() => setCreate(null)} seed={create === "series" ? { seriesId: currentSeries } : undefined} />}
  </>;
}
