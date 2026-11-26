import { useEffect, useMemo, useState } from "react";
import type {
  ComicDramaEditTaskEntry, ComicEditCreate, ComicEditList as Page, ComicEditListEntry, ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicEditApi, editError } from "./edit-api.js";
import { LibraryDialog, MediaPreview } from "./LibraryParts.js";

export function NewComicEdit({ seed, mode = "legacy", open, close }: {
  seed?: Pick<ComicEditCreate, "seriesId" | "takeId">;
  mode?: "free" | "legacy";
  open: (id: string, opts?: { openAutoDialogue?: boolean }) => void;
  close: () => void;
}) {
  const { t } = useI18n();
  const isFree = mode === "free" && !seed?.takeId;
  const dialogTitle = isFree ? "新建自由剪辑任务" : "新建剪辑工程";
  const nameLabel = isFree ? "任务名称" : "工程名称";
  const submitLabel = isFree ? "创建自由任务" : "创建工程";
  return (
    <LibraryDialog
      title={t(dialogTitle)}
      submitLabel={t(submitLabel)}
      close={close}
      describeError={editError}
      save={async (form, signal) => {
        const title = String(form.get("title") ?? "").trim();
        const aspect = form.get("aspectRatio") as ComicTimeline["aspectRatio"] | null;
        const project = await comicEditApi.create({
          title,
          ...seed,
          ...(isFree && !seed?.seriesId && aspect ? { aspectRatio: aspect } : {}),
        }, signal);
        const wantsAutoDialogue = Boolean(seed?.seriesId && form.get("autoDialogue") === "on");
        if (!signal.aborted) open(project.id, wantsAutoDialogue ? { openAutoDialogue: true } : undefined);
      }}
    >
      <label>{t(nameLabel)}<input name="title" required autoFocus maxLength={120} /></label>
      {isFree && !seed?.seriesId && (
        <label>
          {t("画幅比例")}
          <select name="aspectRatio" defaultValue="9:16">
            <option value="9:16">9:16</option>
            <option value="16:9">16:9</option>
            <option value="1:1">1:1</option>
          </select>
        </label>
      )}
      {seed?.takeId && <p>{t("工程将锁定当前预览的片源版本。")}</p>}
      {seed?.seriesId && (
        <>
          <p>{t("工程将按分镜顺序加入本集当前采用的版本。")}</p>
          <label className="comic-sequel-option">
            <input type="checkbox" name="autoDialogue" />
            {t("进入工程后核对范围并批量配音与字幕")}
          </label>
        </>
      )}
    </LibraryDialog>
  );
}

export function ComicEditsIndex({
  open, openDramaTask, openDramaHub, browse, currentDramaId, currentSeries,
}: {
  open: (id: string, opts?: { openAutoDialogue?: boolean }) => void;
  openDramaTask: (dramaId: string, seriesId?: string) => void;
  openDramaHub?: (dramaId: string) => void;
  browse: () => void;
  currentDramaId?: string | null;
  currentSeries?: string;
}) {
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
    if (!window.confirm(t("删除自由剪辑任务「{0}」？", [entry.title]))) return;
    setError("");
    try { await comicEditApi.remove(entry.id, entry.revision); refresh(); }
    catch (err) { setError(editError(err)); }
  };

  const sortedDramaTasks = useMemo(() => {
    const tasks = page && page !== "error" ? (page.dramaTasks ?? []) : [];
    if (!currentDramaId) return tasks;
    return [...tasks].sort((a, b) => {
      if (a.dramaId === currentDramaId && b.dramaId !== currentDramaId) return -1;
      if (b.dramaId === currentDramaId && a.dramaId !== currentDramaId) return 1;
      return 0;
    });
  }, [page, currentDramaId]);

  const lastEdit = page && page !== "error" ? page.lastEdit : null;
  const fallbackLastEntry = page && page !== "error" && !lastEdit && page.lastEditId
    ? page.entries.find(e => e.id === page.lastEditId)
    : undefined;

  const resumeLast = () => {
    if (lastEdit) {
      if (lastEdit.taskKind === "drama" && lastEdit.dramaId) {
        openDramaTask(lastEdit.dramaId, lastEdit.seriesId ?? undefined);
      } else {
        open(lastEdit.id);
      }
    } else if (fallbackLastEntry) {
      open(fallbackLastEntry.id);
    }
  };

  const lastLabel = lastEdit
    ? (lastEdit.taskKind === "drama" && lastEdit.dramaTitle
      ? `《${lastEdit.dramaTitle}》${lastEdit.episodeNo ? ` · ${t("第 {0} 集", [lastEdit.episodeNo])}` : ""}`
      : lastEdit.title)
    : fallbackLastEntry?.title;

  return (
    <div className="comic-edit-workbench">
      <header className="comic-heading">
        <div>
          <h1>{t("剪辑工作台")}</h1>
          <p className="comic-workbench-subtitle">
            {t("新建新剧自动关联剧集剪辑任务（按分集剪辑），也可随时创建自由任务混剪任意片源。")}
          </p>
        </div>
        <div className="comic-actions">
          {lastLabel && (
            <button type="button" onClick={resumeLast}>
              {t("继续上次剪辑")} · {lastLabel}
            </button>
          )}
          <button type="button" onClick={browse}>{t("选择剪辑片源")}</button>
          <button type="button" className="primary" onClick={() => setCreate("empty")}>
            ＋ {t("新建自由任务")}
          </button>
        </div>
      </header>

      {error && <p className="comic-error" role="alert">{t(error)}</p>}

      {page === "error" ? (
        <button type="button" onClick={refresh}>{t("重新读取")}</button>
      ) : !page ? (
        <p role="status">{t("加载中…")}</p>
      ) : (
        <>
          {!cursor && (
            <section className="comic-workbench-section" aria-label={t("剧集剪辑任务")}>
              <div className="comic-section-heading">
                <div className="comic-cut-badges">
                  <h2>{t("剧集剪辑任务")}</h2>
                  <small className="comic-pill" data-tone="frame">{t("作业单位：分集")}</small>
                </div>
                <small className="comic-workbench-count">{t("{0} 部剧集", [sortedDramaTasks.length])}</small>
              </div>
              {sortedDramaTasks.length === 0 ? (
                <p className="comic-empty">{t("暂无关联剧集剪辑任务，新建新剧后将自动在此创建。")}</p>
              ) : (
                <div className="comic-drama-edit-grid">
                  {sortedDramaTasks.map(task => (
                    <DramaEditTaskCard
                      key={task.id}
                      task={task}
                      isCurrent={task.dramaId === currentDramaId}
                      locale={locale}
                      onOpen={(seriesId) => openDramaTask(task.dramaId, seriesId)}
                      onOpenHub={openDramaHub ? () => openDramaHub(task.dramaId) : undefined}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="comic-workbench-section" aria-label={t("自由剪辑任务")}>
            <div className="comic-section-heading">
              <div className="comic-cut-badges">
                <h2>{t("自由剪辑任务")}</h2>
                <small className="comic-pill" data-tone="idle">{t("自由任务")}</small>
              </div>
              <div className="comic-actions">
                {currentSeries && (
                  <button type="button" onClick={() => setCreate("series")}>{t("用本集采用版建自由任务")}</button>
                )}
                <button type="button" onClick={() => setCreate("empty")}>＋ {t("新建自由任务")}</button>
              </div>
            </div>
            {page.entries.length === 0 ? (
              <p className="comic-empty">{t("暂无自由剪辑任务，可新建自由任务或从历史成片选取片源。")}</p>
            ) : (
              <div className="comic-history-list">
                {page.entries.map(entry => (
                  <article key={entry.id}>
                    <button type="button" className="comic-history-title" onClick={() => open(entry.id)}>
                      <div className="comic-cut-badges">
                        <small className="comic-pill" data-tone="idle">{t("自由任务")}</small>
                        {entry.dramaTitle && (
                          <small className="comic-pill" data-tone="frame">
                            {entry.dramaTitle}{entry.episodeNo ? ` · ${t("第 {0} 集", [entry.episodeNo])}` : ""}
                          </small>
                        )}
                      </div>
                      <strong>{entry.title}</strong>
                    </button>
                    <div className="comic-actions">
                      <small>{new Date(entry.updatedAt).toLocaleString(locale)}</small>
                      <button type="button" onClick={() => open(entry.id)}>{t("进入剪辑")}</button>
                      <button type="button" onClick={() => void remove(entry)}>{t("删除")}</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {(cursor || page.nextCursor) && (
              <div className="comic-actions">
                {cursor && <button type="button" onClick={() => setCursor(undefined)}>{t("第一页")}</button>}
                {page.nextCursor && <button type="button" onClick={() => setCursor(page.nextCursor ?? undefined)}>{t("下一页")}</button>}
              </div>
            )}
          </section>
        </>
      )}

      {create && (
        <NewComicEdit
          mode="free"
          open={open}
          close={() => setCreate(null)}
          seed={create === "series" ? { seriesId: currentSeries } : undefined}
        />
      )}
    </div>
  );
}

function DramaEditTaskCard({
  task, isCurrent, locale, onOpen, onOpenHub,
}: {
  task: ComicDramaEditTaskEntry;
  isCurrent: boolean;
  locale: string;
  onOpen: (seriesId?: string) => void;
  onOpenHub?: () => void;
}) {
  const { t } = useI18n();
  const visibleEpisodes = task.episodes.slice(0, 8);
  const extraCount = Math.max(0, task.episodes.length - visibleEpisodes.length);

  return (
    <article className="comic-drama-edit-card" data-current={isCurrent ? "true" : undefined}>
      <div className="comic-drama-edit-head">
        {task.coverMediaId ? (
          <MediaPreview
            media={{ id: task.coverMediaId, hasThumbnail: true, durationMs: null }}
            title={task.dramaTitle}
            thumbOnly
          />
        ) : (
          <div className="comic-media-well comic-character-initial" aria-hidden="true">
            {Array.from(task.dramaTitle)[0] ?? "剧"}
          </div>
        )}
        <div className="comic-drama-edit-meta">
          <div className="comic-cut-badges">
            <span className="comic-hierarchy-level">{t("剧集任务")}</span>
            {isCurrent && <small className="comic-pill" data-tone="busy">{t("当前剧目")}</small>}
            <span className="comic-ratio">{task.aspectRatio}</span>
          </div>
          <h3>《{task.dramaTitle}》</h3>
          <div className="comic-episode-stats">
            <span>{t("共 {0} 集", [task.episodeCount])}</span>
            <span>{t("已剪 {0} 集", [task.editedEpisodeCount])}</span>
            <span>{t("已导出 {0} 集", [task.exportedEpisodeCount])}</span>
          </div>
          {task.lastEpisodeNo && (
            <small className="comic-drama-edit-last">
              {t("上次剪辑：第 {0} 集", [task.lastEpisodeNo])}
              {task.lastEpisodeTitle ? ` · ${task.lastEpisodeTitle}` : ""}
            </small>
          )}
        </div>
      </div>

      {task.episodes.length === 0 ? (
        <p className="comic-generation-note">{t("暂无分集，创建第 1 集后即可按分集剪辑。")}</p>
      ) : (
        <div className="comic-drama-edit-episodes" aria-label={t("按分集快速进入")}>
          {visibleEpisodes.map(ep => {
            const state = ep.hasReadyRender ? "exported"
              : ep.timelineClipCount > 0 ? "edited"
                : ep.adoptedClipCount > 0 ? "ready" : "idle";
            const statusText = ep.hasReadyRender ? t("已导出")
              : ep.timelineClipCount > 0 ? t("{0} 段", [ep.timelineClipCount])
                : ep.adoptedClipCount > 0 ? t("待入轨")
                  : t("待成片");
            return (
              <button
                key={ep.seriesId}
                type="button"
                className="comic-ep-chip"
                data-state={state}
                data-active={ep.seriesId === task.lastSeriesId ? "true" : undefined}
                onClick={() => onOpen(ep.seriesId)}
              >
                <span>{t("第 {0} 集", [ep.episodeNo])}</span>
                <small>{statusText}</small>
              </button>
            );
          })}
          {extraCount > 0 && (
            <button type="button" className="comic-ep-chip" data-state="idle" onClick={() => onOpen()}>
              <span>+{extraCount} {t("集")}</span>
            </button>
          )}
        </div>
      )}

      <footer className="comic-drama-edit-foot">
        <small>{new Date(task.updatedAt).toLocaleString(locale)}</small>
        <div className="comic-actions">
          {onOpenHub && (
            <button type="button" onClick={onOpenHub}>{t("全剧筹备")}</button>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => onOpen(task.lastSeriesId ?? undefined)}
          >
            {t("进入剪辑")}
          </button>
        </div>
      </footer>
    </article>
  );
}
