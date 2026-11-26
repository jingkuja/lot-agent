import { useCallback, useEffect, useRef, useState } from "react";
import type { ComicDramaEditEpisodeItem, ComicDramaEditTaskView, ComicEdit } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { ComicEditWorkspace } from "./ComicEditWorkspace.js";
import { comicEditApi, editError } from "./edit-api.js";

function episodeBadge(ep: ComicDramaEditEpisodeItem, t: (key: string, args?: Array<string | number>) => string) {
  if (ep.hasReadyRender) return { tone: "done" as const, text: t("已导出") };
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
  openEpisodeEditor: (dramaId: string, seriesId: string) => void;
  openCreateEpisode?: (dramaId: string) => void;
  openVideo: (seriesId: string, clipId: string) => void;
  setGuard: (guard: (() => boolean) | null) => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<ComicDramaEditTaskView | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const childGuardRef = useRef<(() => boolean) | null>(null);
  const registerChildGuard = useCallback((guard: (() => boolean) | null) => {
    childGuardRef.current = guard;
    setGuard(guard);
  }, [setGuard]);

  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setError("");
    void comicEditApi.openDramaTask(dramaId, seriesId, controller.signal).then(data => {
      if (!controller.signal.aborted) setView(data);
    }).catch(err => {
      if (!controller.signal.aborted) setError(editError(err));
    });
    return () => controller.abort();
  }, [dramaId, seriesId, attempt]);

  const handleProjectUpdated = useCallback((saved: ComicEdit) => {
    setView(cur => {
      if (!cur) return cur;
      const episodes = saved.dramaEpisodes ?? cur.episodes;
      return { ...cur, episodes, edit: saved };
    });
  }, []);

  const switchEpisode = (targetSeriesId: string) => {
    if (!view || targetSeriesId === view.activeSeriesId) return;
    if (childGuardRef.current && !childGuardRef.current()) return;
    openEpisodeEditor(dramaId, targetSeriesId);
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

  return (
    <div className="comic-drama-edit-workspace">
      <section className="comic-drama-task-banner" aria-label={t("剧集剪辑任务")}>
        <div className="comic-drama-task-top">
          <div className="comic-drama-task-title">
            <div className="comic-cut-badges">
              <span className="comic-hierarchy-level">{t("剧集剪辑任务")}</span>
              <small className="comic-pill" data-tone="frame">{t("作业单位：分集")}</small>
              <span className="comic-ratio">{task.aspectRatio}</span>
              {task.archivedAt && <small className="comic-pill" data-tone="idle">{t("已归档（只读）")}</small>}
            </div>
            <strong>《{task.dramaTitle}》</strong>
          </div>
          <div className="comic-actions">
            {activeSeriesId && (
              <button type="button" onClick={() => {
                if (childGuardRef.current && !childGuardRef.current()) return;
                openEpisodeProduction(activeSeriesId);
              }}>
                {t("回到本集分镜")}
              </button>
            )}
            <button type="button" onClick={() => {
              if (childGuardRef.current && !childGuardRef.current()) return;
              openDramaHub(dramaId, "episodes");
            }}>
              {t("全剧筹备")}
            </button>
            <button type="button" onClick={() => {
              if (childGuardRef.current && !childGuardRef.current()) return;
              exit();
            }}>
              {t("返回剪辑工作台")}
            </button>
          </div>
        </div>

        {episodes.length > 0 && (
          <nav className="comic-episode-unit-bar" aria-label={t("分集作业列表")}>
            {episodes.map(ep => {
              const badge = episodeBadge(ep, t);
              const active = ep.seriesId === activeSeriesId;
              return (
                <button
                  key={ep.seriesId}
                  type="button"
                  className="comic-episode-unit-btn"
                  aria-current={active ? "true" : undefined}
                  onClick={() => switchEpisode(ep.seriesId)}
                >
                  <span className="comic-episode-unit-title">
                    <strong>{t("第 {0} 集", [ep.episodeNo])}</strong>
                    <span>{ep.title}</span>
                  </span>
                  <span className="comic-episode-unit-badges">
                    <small className="comic-pill" data-tone={badge.tone}>{badge.text}</small>
                    {ep.unaddedAdoptedCount > 0 && ep.timelineClipCount > 0 && (
                      <small className="comic-pill" data-tone="busy">+{ep.unaddedAdoptedCount}</small>
                    )}
                  </span>
                </button>
              );
            })}
          </nav>
        )}
      </section>

      {episodes.length === 0 || !edit ? (
        <div className="comic-empty comic-drama-empty-episodes">
          <h2>{t("《{0}》暂无可剪辑分集", [task.dramaTitle])}</h2>
          <p>
            {t("关联剧的剪辑任务以分集为作业单位。先创建第 1 集并编排分镜、生成采用视频后，即可在此按分集剪辑与导出。")}
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
            <button type="button" onClick={exit}>{t("返回剪辑工作台")}</button>
          </div>
        </div>
      ) : (
        <ComicEditWorkspace
          key={edit.id}
          id={edit.id}
          initialData={edit}
          embeddedInDramaTask
          setGuard={registerChildGuard}
          openVideo={openVideo}
          onProjectChange={handleProjectUpdated}
          onSwitchEpisode={openEpisodeEditor}
          exit={exit}
        />
      )}
    </div>
  );
}
