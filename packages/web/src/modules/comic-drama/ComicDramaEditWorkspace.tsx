import { useCallback, useEffect, useRef, useState } from "react";
import type { ComicDramaEditEpisodeItem, ComicDramaEditTaskView, ComicEdit } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { ComicEditWorkspace } from "./ComicEditWorkspace.js";
import { comicEditApi, editError } from "./edit-api.js";

function episodeBadge(ep: ComicDramaEditEpisodeItem, t: (key: string, args?: Array<string | number>) => string) {
  if (ep.hasReadyRender) return { tone: "done" as const, text: t("已合并成集") };
  if (ep.activeRenderStatus === "running" || ep.activeRenderStatus === "pending") {
    return { tone: "busy" as const, text: t("正在合并成集") };
  }
  if (ep.timelineClipCount > 0) {
    return {
      tone: "busy" as const,
      text: t("{0} 段 · {1} 秒", [ep.timelineClipCount, +(ep.timelineDurationMs / 1000).toFixed(1)]),
    };
  }
  if (ep.adoptedClipCount > 0) return { tone: "frame" as const, text: t("{0} 段待入轨", [ep.adoptedClipCount]) };
  return { tone: "idle" as const, text: t("{0} 分镜", [ep.clipCount]) };
}

export function ComicDramaEditWorkspace({
  dramaId,
  seriesId,
  exit,
  openDramaHub,
  openEpisodeProduction,
  openDramaTaskSelect,
  openEpisodeEditor,
  openCreateEpisode,
  openVideo,
  setGuard,
}: {
  dramaId: string;
  seriesId?: string;
  exit: () => void;
  openDramaHub: (dramaId: string, tab?: "outline" | "episodes") => void;
  openEpisodeProduction: (seriesId: string) => void;
  openDramaTaskSelect?: (dramaId: string) => void;
  openEpisodeEditor: (dramaId: string, seriesId: string) => void;
  openCreateEpisode?: (dramaId: string) => void;
  openVideo: (seriesId: string, clipId: string) => void;
  setGuard: (guard: (() => boolean) | null) => void;
}) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<ComicDramaEditTaskView | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busyRenderId, setBusyRenderId] = useState<string | null>(null);
  const [previewRender, setPreviewRender] = useState<{
    episodeLabel: string;
    renderId: string;
    url: string;
  } | null>(null);
  const previewDialogRef = useRef<HTMLDialogElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const childGuardRef = useRef<(() => boolean) | null>(null);

  const closePreview = useCallback(() => {
    const player = previewVideoRef.current;
    if (player) {
      try {
        player.pause();
        player.removeAttribute("src");
        player.load();
      } catch { /* ignore in test DOM */ }
    }
    setPreviewRender(null);
  }, []);
  const registerChildGuard = useCallback((guard: (() => boolean) | null) => {
    childGuardRef.current = guard;
    setGuard(guard);
  }, [setGuard]);

  useEffect(() => {
    if (!seriesId) {
      childGuardRef.current = null;
      setGuard(null);
    }
  }, [seriesId, setGuard]);

  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setError("");
    setActionError("");
    const loadTask = seriesId
      ? comicEditApi.openDramaTask(dramaId, seriesId, controller.signal)
      : comicEditApi.getDramaTask(dramaId, undefined, controller.signal);
    void loadTask.then(data => {
      if (!controller.signal.aborted) setView(data);
    }).catch(err => {
      if (!controller.signal.aborted) setError(editError(err));
    });
    return () => controller.abort();
  }, [dramaId, seriesId, attempt]);

  useEffect(() => {
    const el = previewDialogRef.current;
    if (previewRender && el && !el.open) {
      if (typeof el.showModal === "function") {
        try { el.showModal(); } catch { el.setAttribute("open", ""); }
      } else {
        el.setAttribute("open", "");
      }
    }
  }, [previewRender]);

  const refreshEpisodeList = useCallback(() => {
    void comicEditApi.getDramaTask(dramaId).then(fresh => {
      setView(cur => cur ? { ...cur, task: fresh.task, episodes: fresh.episodes } : fresh);
    }).catch(() => {});
  }, [dramaId]);

  const handleProjectUpdated = useCallback((saved: ComicEdit) => {
    setView(cur => {
      if (!cur) return cur;
      const episodes = saved.dramaEpisodes ?? cur.episodes;
      return { ...cur, episodes, edit: saved };
    });
  }, []);

  const canLeaveEpisode = () => !childGuardRef.current || childGuardRef.current();

  const goBackToSelect = () => {
    if (openDramaTaskSelect) openDramaTaskSelect(dramaId);
    else if (canLeaveEpisode()) exit();
  };

  const switchEpisode = (targetSeriesId: string) => {
    if (!view || targetSeriesId === view.activeSeriesId) return;
    if (!canLeaveEpisode()) return;
    openEpisodeEditor(dramaId, targetSeriesId);
  };

  const playEpisodeDeliverable = async (ep: ComicDramaEditEpisodeItem) => {
    if (!ep.latestReadyRenderId || busyRenderId) return;
    setBusyRenderId(ep.latestReadyRenderId);
    setActionError("");
    try {
      const { url } = await comicEditApi.downloadRender(ep.latestReadyRenderId, true);
      setPreviewRender({
        episodeLabel: t("第 {0} 集（{1}）", [ep.episodeNo, ep.title]),
        renderId: ep.latestReadyRenderId,
        url,
      });
    } catch (err) {
      setActionError(editError(err));
    } finally {
      setBusyRenderId(null);
    }
  };

  const downloadEpisodeDeliverable = async (renderId: string) => {
    if (busyRenderId) return;
    setBusyRenderId(renderId);
    setActionError("");
    try {
      const result = await comicEditApi.downloadRender(renderId);
      const link = document.createElement("a");
      link.href = result.url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setActionError(editError(err));
    } finally {
      setBusyRenderId(null);
    }
  };

  if (error) {
    return (
      <div className="comic-error" role="alert">
        {t(error)}{" "}
        <button type="button" onClick={() => setAttempt(v => v + 1)}>{t("重新读取")}</button>{" "}
        <button type="button" onClick={exit}>{t("返回剪辑工作台")}</button>
      </div>
    );
  }
  if (!view) return <p role="status">{t("加载中…")}</p>;

  const { task, episodes, activeSeriesId, edit } = view;
  const editedCount = episodes.filter(ep => ep.timelineClipCount > 0).length;
  const exportedCount = episodes.filter(ep => ep.hasReadyRender).length;
  const lastEpisode = task.lastSeriesId ? episodes.find(ep => ep.seriesId === task.lastSeriesId) : undefined;

  if (!seriesId) {
    return (
      <div className="comic-drama-edit-workspace">
        <nav className="comic-hierarchy-bar" aria-label={t("剪辑层级路径")}>
          <button type="button" className="comic-hierarchy-btn" onClick={exit}>
            {t("剪辑工作台")}
          </button>
          <span className="comic-hierarchy-sep" aria-hidden="true">›</span>
          <div className="comic-hierarchy-tier" data-tier="drama">
            <span className="comic-hierarchy-level">{t("整部剧剪辑任务")}</span>
            <strong className="comic-hierarchy-name">《{task.dramaTitle}》</strong>
            <small className="comic-hierarchy-count">{t("共 {0} 集", [episodes.length])}</small>
          </div>
          <div className="comic-hierarchy-actions">
            {openCreateEpisode && !task.archivedAt && (
              <button type="button" className="comic-hierarchy-btn" onClick={() => openCreateEpisode(dramaId)}>
                ＋ {episodes.length === 0 ? t("创建第 1 集") : t("新增分集")}
              </button>
            )}
            <button type="button" className="comic-hierarchy-btn" onClick={() => openDramaHub(dramaId, "episodes")}>
              {t("全剧筹备")}
            </button>
          </div>
        </nav>

        <header className="comic-heading comic-episode-slate">
          <div className="comic-drama-task-title">
            <div className="comic-cut-badges">
              <span className="comic-hierarchy-level">{t("任务单位：整部剧")}</span>
              <small className="comic-pill" data-tone="frame">{t("执行单位：分集")}</small>
              <span className="comic-ratio">{task.aspectRatio}</span>
              {task.archivedAt && <small className="comic-pill" data-tone="idle">{t("已归档（只读）")}</small>}
            </div>
            <h1>《{task.dramaTitle}》 · {t("剧集剪辑任务")}</h1>
            <p>
              {t("请先选择分集进入具体剪辑操作台；在操作台中完成分镜拼接、配音、音效与字幕后，可合并成一集完整剧集成果。")}
            </p>
            <div className="comic-episode-stats">
              <span>{t("共 {0} 集", [episodes.length])}</span>
              <span>{t("已剪 {0} 集", [editedCount])}</span>
              <span>{t("已合成分集 {0}", [exportedCount])}</span>
            </div>
          </div>
          <div className="comic-actions">
            {lastEpisode && (
              <button
                type="button"
                className="primary"
                onClick={() => openEpisodeEditor(dramaId, lastEpisode.seriesId)}
              >
                {t("继续第 {0} 集", [lastEpisode.episodeNo])}
              </button>
            )}
            <button type="button" onClick={exit}>{t("返回剪辑工作台")}</button>
          </div>
        </header>

        {actionError && <p className="comic-error" role="alert">{t(actionError)}</p>}

        {episodes.length === 0 ? (
          <div className="comic-empty comic-drama-empty-episodes">
            <h2>{t("《{0}》暂无可剪辑分集", [task.dramaTitle])}</h2>
            <p>
              {t("关联剧的剪辑任务单位为整部剧，执行单位为分集。先创建第 1 集并完成分镜生成采用后，即可在此选集进入具体操作台。")}
            </p>
            <div className="comic-actions">
              {openCreateEpisode && !task.archivedAt ? (
                <button type="button" className="primary" onClick={() => openCreateEpisode(dramaId)}>
                  ＋ {t("创建第 1 集")}
                </button>
              ) : (
                <button type="button" className="primary" onClick={() => openDramaHub(dramaId, "episodes")}>
                  {t("前往全剧筹备创建分集")}
                </button>
              )}
              <button type="button" onClick={() => openDramaHub(dramaId, "outline")}>{t("全剧筹备")}</button>
            </div>
          </div>
        ) : (
          <section className="comic-workbench-section" aria-label={t("分集执行列表")}>
            <div className="comic-section-heading">
              <div>
                <h2>{t("选择分集进入操作台")}</h2>
                <small className="comic-workbench-count">
                  {t("点击任意分集进入「操作台 - 分集」，分镜剪辑完成后可合并为该集成片")}
                </small>
              </div>
              <small className="comic-workbench-count">{t("共 {0} 集", [episodes.length])}</small>
            </div>
            <div className="comic-drama-ep-select-grid">
              {episodes.map(ep => {
                const badge = episodeBadge(ep, t);
                const isLast = ep.seriesId === task.lastSeriesId;
                return (
                  <article
                    key={ep.seriesId}
                    className="comic-drama-ep-unit-card"
                    data-current={isLast ? "true" : undefined}
                  >
                    <div className="comic-cut-badges">
                      <span className="comic-hierarchy-level">{t("第 {0} 集", [ep.episodeNo])}</span>
                      <small className="comic-pill" data-tone={badge.tone}>{badge.text}</small>
                      {isLast && <small className="comic-pill" data-tone="frame">{t("上次剪辑")}</small>}
                    </div>
                    <h3>{t("第 {0} 集（{1}）", [ep.episodeNo, ep.title])}</h3>
                    {ep.logline && <p className="comic-episode-card-logline">{ep.logline}</p>}
                    <div className="comic-drama-ep-metrics">
                      <div>
                        <small>{t("分镜成片")}</small>
                        <strong>{t("已采用 {0}/{1}", [ep.adoptedClipCount, ep.clipCount])}</strong>
                      </div>
                      <div>
                        <small>{t("剪辑时间线")}</small>
                        <strong>
                          {ep.timelineClipCount > 0
                            ? t("{0} 段 · {1} 秒", [ep.timelineClipCount, +(ep.timelineDurationMs / 1000).toFixed(1)])
                            : t("待进入操作台初始化")}
                        </strong>
                      </div>
                    </div>
                    {(ep.unaddedAdoptedCount > 0 || ep.outdatedAdoptedCount > 0) && (
                      <div className="comic-cut-badges">
                        {ep.unaddedAdoptedCount > 0 && (
                          <small className="comic-pill" data-tone="busy">
                            {t("新增 {0} 个采用分镜待入轨", [ep.unaddedAdoptedCount])}
                          </small>
                        )}
                        {ep.outdatedAdoptedCount > 0 && (
                          <small className="comic-pill" data-tone="frame">
                            {t("{0} 个分镜有新采用版", [ep.outdatedAdoptedCount])}
                          </small>
                        )}
                      </div>
                    )}
                    <div className="comic-drama-ep-deliverable">
                      {ep.latestReadyRenderId ? (
                        <>
                          <div>
                            <strong>{t("一集剧成果已合并")}</strong>
                            <small>
                              {t("导出修订 {0}", [ep.latestReadyRenderRevision ?? 1])}
                              {" · "}
                              {t("{0} 秒", [+((ep.latestReadyRenderDurationMs ?? 0) / 1000).toFixed(1)])}
                              {ep.latestReadyRenderFps ? ` · ${ep.latestReadyRenderFps} fps` : ""}
                            </small>
                          </div>
                          <div className="comic-actions">
                            <button
                              type="button"
                              disabled={busyRenderId !== null}
                              onClick={() => void playEpisodeDeliverable(ep)}
                            >
                              {t("试看本集成片")}
                            </button>
                            <button
                              type="button"
                              disabled={busyRenderId !== null}
                              onClick={() => void downloadEpisodeDeliverable(ep.latestReadyRenderId!)}
                            >
                              {t("下载本集 MP4")}
                            </button>
                          </div>
                        </>
                      ) : ep.activeRenderStatus ? (
                        <small className="comic-generation-note">{t("正在合并本集 MP4 成片…")}</small>
                      ) : (
                        <small>{t("完成分镜剪辑后，可在操作台一键合并为本集 MP4 成果")}</small>
                      )}
                    </div>
                    <footer className="comic-drama-edit-foot">
                      <small>{new Date(ep.updatedAt).toLocaleString(locale)}</small>
                      <div className="comic-actions">
                        <button type="button" onClick={() => openEpisodeProduction(ep.seriesId)}>
                          {t("分镜制作")}
                        </button>
                        <button
                          type="button"
                          className="primary"
                          onClick={() => openEpisodeEditor(dramaId, ep.seriesId)}
                        >
                          {t("进入操作台 · 第 {0} 集", [ep.episodeNo])}
                        </button>
                      </div>
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {previewRender && (
          <dialog
            ref={previewDialogRef}
            className="comic-dialog comic-temp-preview-dialog"
            aria-label={t("试看本集成片")}
            onCancel={event => {
              event.preventDefault();
              closePreview();
            }}
          >
            <div className="comic-temp-preview-head">
              <h2>《{task.dramaTitle}》· {previewRender.episodeLabel}</h2>
              <button type="button" onClick={closePreview}>{t("关闭")}</button>
            </div>
            <div className="comic-temp-preview-stage">
              <video ref={previewVideoRef} src={previewRender.url} controls autoPlay playsInline />
            </div>
            <div className="comic-actions">
              <button type="button" onClick={() => void downloadEpisodeDeliverable(previewRender.renderId)}>
                {t("下载本集 MP4")}
              </button>
              <button type="button" className="primary" onClick={closePreview}>
                {t("关闭")}
              </button>
            </div>
          </dialog>
        )}
      </div>
    );
  }

  return (
    <div className="comic-drama-edit-workspace">
      <nav className="comic-hierarchy-bar" aria-label={t("剪辑层级路径")}>
        <button type="button" className="comic-hierarchy-btn" onClick={exit}>
          {t("剪辑工作台")}
        </button>
        <span className="comic-hierarchy-sep" aria-hidden="true">›</span>
        <div className="comic-hierarchy-tier" data-tier="drama">
          <span className="comic-hierarchy-level">{t("整部剧")}</span>
          <button type="button" className="comic-hierarchy-drama-link" onClick={goBackToSelect}>
            《{task.dramaTitle}》
          </button>
          <button type="button" className="comic-hierarchy-btn" onClick={goBackToSelect}>
            {t("返回选集（{0} 集）", [episodes.length])}
          </button>
        </div>
        <span className="comic-hierarchy-sep" aria-hidden="true">›</span>
        <div className="comic-hierarchy-tier" data-tier="episode">
          <span className="comic-hierarchy-level">{t("具体操作台")}</span>
          {episodes.length > 0 && (
            <select
              className="comic-hierarchy-select"
              aria-label={t("切换分集操作台")}
              value={activeSeriesId ?? ""}
              onChange={event => {
                if (event.target.value) switchEpisode(event.target.value);
              }}
            >
              {episodes.map(ep => (
                <option key={ep.seriesId} value={ep.seriesId}>
                  {t("第 {0} 集（{1}）", [ep.episodeNo, ep.title])}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="comic-hierarchy-actions">
          {activeSeriesId && (
            <button
              type="button"
              className="comic-hierarchy-btn"
              onClick={() => openEpisodeProduction(activeSeriesId)}
            >
              {t("回到本集分镜")}
            </button>
          )}
          <button
            type="button"
            className="comic-hierarchy-btn"
            onClick={() => openDramaHub(dramaId, "episodes")}
          >
            {t("全剧筹备")}
          </button>
        </div>
      </nav>

      {!edit ? (
        <div className="comic-empty comic-drama-empty-episodes">
          <h2>{t("暂无分集操作台")}</h2>
          <p>{t("请返回选集页选择有效分集或先创建第 1 集。")}</p>
          <button type="button" className="primary" onClick={goBackToSelect}>
            {t("返回选集")}
          </button>
        </div>
      ) : (
        <ComicEditWorkspace
          key={edit.id}
          id={edit.id}
          initialData={edit}
          dramaEpisodes={episodes}
          embeddedInDramaTask
          setGuard={registerChildGuard}
          openVideo={openVideo}
          onProjectChange={handleProjectUpdated}
          onOpenDramaSelect={openDramaTaskSelect ? () => openDramaTaskSelect(dramaId) : exit}
          onEpisodeProduction={openEpisodeProduction}
          onRenderUpdated={refreshEpisodeList}
          onSwitchEpisode={openEpisodeEditor}
          exit={exit}
        />
      )}
    </div>
  );
}
