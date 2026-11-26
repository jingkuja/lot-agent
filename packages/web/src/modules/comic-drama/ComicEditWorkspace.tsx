import { useCallback, useEffect, useRef, useState } from "react";
import {
  comicTimelineSchema, comicVideoItem, layoutComicTimeline,
  type ComicAutoDialoguePlan, type ComicAutoDialogueResult, type ComicEdit, type ComicEditAutoDialogueOverride,
  type ComicEditSource, type ComicMaterial, type ComicTimeline, type ComicVideoTake,
} from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { ComicTrimmedPreview } from "./ComicTrimmedPreview.js";
import { ComicTimelineTracks } from "./ComicTimelineTracks.js";
import { ComicTempPreviewDialog } from "./ComicTempPreviewDialog.js";
import { ComicRenderPanel } from "./ComicRenderPanel.js";
import { ComicDialogueAudio } from "./ComicDialogueAudio.js";
import { ComicVideoHistory } from "./ComicVideoHistory.js";
import { comicEditApi, editError } from "./edit-api.js";
import { comicGenerationApi } from "./generation-api.js";
import { comicLibraryApi } from "./library-api.js";
import { LibraryDialog } from "./LibraryParts.js";
import { fixAllTimelineOverflows } from "./timeline-ops.js";

type Video = ComicTimeline["video"][number];
type Editable = Pick<ComicEdit, "title" | "timeline">;
const seconds = (ms: number) => String(ms / 1000);

export function ComicEditWorkspace({
  id,
  initialData,
  dramaEpisodes: dramaEpisodesProp,
  embeddedInDramaTask = false,
  exit,
  openVideo,
  setGuard,
  autoOpenDialogue,
  onAutoDialogueOpened,
  onProjectChange,
  onOpenDramaSelect,
  onEpisodeProduction,
  onRenderUpdated,
  onSwitchEpisode,
}: {
  id: string;
  initialData?: ComicEdit | null;
  dramaEpisodes?: ComicEdit["dramaEpisodes"];
  embeddedInDramaTask?: boolean;
  exit: () => void;
  openVideo: (seriesId: string, clipId: string) => void;
  setGuard: (guard: (() => boolean) | null) => void;
  autoOpenDialogue?: boolean;
  onAutoDialogueOpened?: () => void;
  onProjectChange?: (project: ComicEdit) => void;
  onOpenDramaSelect?: (dramaId: string) => void;
  onEpisodeProduction?: (seriesId: string) => void;
  onRenderUpdated?: () => void;
  onSwitchEpisode?: (dramaId: string, seriesId: string) => void;
}) {
  const { t } = useI18n();
  const [project, setProject] = useState<ComicEdit | null>(initialData ?? null);
  const [draft, setDraft] = useState<Editable | null>(initialData ? { title: initialData.title, timeline: initialData.timeline } : null);
  const [extra, setExtra] = useState<ComicEditSource[]>([]);
  const [extraAudio, setExtraAudio] = useState<Array<{ id: string; durationMs: number }>>([]);
  const [selected, setSelected] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [savePaused, setSavePaused] = useState(false);
  const [picking, setPicking] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(true);
  const [replacement, setReplacement] = useState(false);
  const [dialogueModalOpen, setDialogueModalOpen] = useState(false);
  const [dialoguePlan, setDialoguePlan] = useState<ComicAutoDialoguePlan | null>(null);
  const [dialogueResult, setDialogueResult] = useState<ComicAutoDialogueResult | null>(null);
  const [dialogueBusy, setDialogueBusy] = useState(false);
  const [dialogueError, setDialogueError] = useState("");
  const [dialogueOverrides, setDialogueOverrides] = useState<Record<string, ComicEditAutoDialogueOverride>>({});
  const [replaceNativeIds, setReplaceNativeIds] = useState<string[]>([]);
  const autoOpenedRef = useRef(false);
  const initialUsedRef = useRef(Boolean(initialData));
  const onProjectChangeRef = useRef(onProjectChange);
  onProjectChangeRef.current = onProjectChange;
  const [position, setPosition] = useState(0);
  const [seek, setSeek] = useState({ ms: 0 });
  const [interacting, setInteracting] = useState(false);
  const [tempPreviewOpen, setTempPreviewOpen] = useState(false);
  const [audioNames, setAudioNames] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<{ past: ComicTimeline[]; future: ComicTimeline[] }>({ past: [], future: [] });
  const draggingIndex = useRef<number | null>(null);
  const pending = useRef(false);
  const savePromiseRef = useRef<Promise<ComicEdit | null> | null>(null);
  const readOnly = Boolean(project?.dramaArchivedAt);
  const dirty = !!project && !!draft && !readOnly && (draft.title !== project.title || draft.timeline !== project.timeline);
  const latestRef = useRef({ project, draft, dirty });
  latestRef.current = { project, draft, dirty };
  const receive = useCallback((data: ComicEdit) => {
    setProject(data);
    setDraft({ title: data.title, timeline: data.timeline });
    setExtra([]);
    setExtraAudio([]);
    setSavePaused(false);
    onProjectChangeRef.current?.(data);
  }, []);
  useEffect(() => {
    setGuard(() => !pending.current && (!dirty || window.confirm(t("放弃未保存的工程修改？"))));
    return () => setGuard(null);
  }, [dirty, setGuard, t]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => {
    if (attempt === 0 && initialUsedRef.current && initialData?.id === id) {
      initialUsedRef.current = false;
      return;
    }
    const controller = new AbortController();
    setHistory({ past: [], future: [] });
    setAudioNames({});
    void comicEditApi.get(id, controller.signal).then(data => {
      if (!controller.signal.aborted) { receive(data); setError(""); }
    }).catch(err => { if (!controller.signal.aborted) setError(editError(err)); });
    return () => controller.abort();
  }, [id, attempt, initialData, receive]);

  const reload = () => {
    if (pending.current || (dirty && !window.confirm(t("放弃未保存的工程修改？")))) return;
    setAttempt(value => value + 1);
  };
  const run = useCallback(async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try { await work(); }
    catch (error) { setError(editError(error)); }
    finally { pending.current = false; setSaving(false); }
  }, []);
  const performSave = useCallback(async (
    targetTitle: string,
    targetTimeline: ComicTimeline,
    expectedRevision: number,
  ): Promise<ComicEdit | null> => {
    if (!targetTitle.trim()) return null;
    if (savePromiseRef.current) await savePromiseRef.current;
    if (pending.current) return null;
    pending.current = true;
    setSaving(true);
    setError("");
    const promise = (async () => {
      try {
        const saved = await comicEditApi.update(id, {
          title: targetTitle,
          timeline: targetTimeline,
          expectedRevision,
        });
        receive(saved);
        return saved;
      } catch (reason) {
        setSavePaused(true);
        setError(editError(reason));
        return null;
      } finally {
        pending.current = false;
        setSaving(false);
        savePromiseRef.current = null;
      }
    })();
    savePromiseRef.current = promise;
    return promise;
  }, [id]);
  const save = useCallback(() => {
    if (!project || !draft || !dirty || !draft.title.trim()) return;
    void performSave(draft.title, draft.timeline, project.revision);
  }, [draft, dirty, performSave, project]);
  useEffect(() => {
    if (!dirty || saving || savePaused || picking || replacement || interacting || tempPreviewOpen) return;
    const timer = setTimeout(save, 850);
    return () => clearTimeout(timer);
  }, [dirty, interacting, picking, replacement, save, savePaused, saving, tempPreviewOpen]);
  const apply = useCallback((value: ComicTimeline) => {
    const valid = comicTimelineSchema.safeParse(value);
    if (!valid.success) { setError("请检查时间线中的裁切和素材"); return; }
    setError("");
    const curDraft = latestRef.current.draft;
    if (curDraft && valid.data !== curDraft.timeline) {
      setHistory(prev => ({
        past: [...prev.past.slice(-49), curDraft.timeline],
        future: [],
      }));
    }
    setDraft(previous => previous && { ...previous, timeline: valid.data });
  }, []);
  const ensureSaved = useCallback(async (): Promise<ComicEdit | null> => {
    if (savePromiseRef.current) await savePromiseRef.current;
    const latest = latestRef.current;
    if (!latest.project || !latest.draft) return null;
    if (!latest.dirty) return latest.project;
    return performSave(latest.draft.title, latest.draft.timeline, latest.project.revision);
  }, [performSave]);
  const fixOverflowAndSave = useCallback(async (): Promise<ComicEdit | null> => {
    if (savePromiseRef.current) await savePromiseRef.current;
    const latest = latestRef.current;
    if (!latest.project || !latest.draft) return null;
    const fixed = fixAllTimelineOverflows(latest.draft.timeline);
    apply(fixed);
    return performSave(latest.draft.title, fixed, latest.project.revision);
  }, [apply, performSave]);
  const undo = useCallback(() => {
    if (saving || !draft || !history.past.length) return;
    const previous = history.past[history.past.length - 1]!;
    setHistory(prev => ({
      past: prev.past.slice(0, -1),
      future: [draft.timeline, ...prev.future.slice(0, 49)],
    }));
    setError("");
    setDraft({ ...draft, timeline: previous });
  }, [draft, history.past, saving]);
  const redo = useCallback(() => {
    if (saving || !draft || !history.future.length) return;
    const next = history.future[0]!;
    setHistory(prev => ({
      past: [...prev.past.slice(-49), draft.timeline],
      future: prev.future.slice(1),
    }));
    setError("");
    setDraft({ ...draft, timeline: next });
  }, [draft, history.future, saving]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (saving || picking || replacement || dialogueModalOpen || tempPreviewOpen) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey && history.past.length) {
        event.preventDefault();
        undo();
      } else if (((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) && history.future.length) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialogueModalOpen, history.future.length, history.past.length, picking, redo, replacement, saving, tempPreviewOpen, undo]);
  const choose = (takeId: string) => void run(async () => {
    const take = await comicGenerationApi.videoTake(takeId);
    if (!draft || !take.mediaId || take.durationMs <= 0) return;
    const added = comicVideoItem(crypto.randomUUID(), { takeId, durationMs: take.durationMs });
    setExtra(values => [...values, {
      takeId, mediaId: take.mediaId!, version: take.version, durationMs: take.durationMs,
      seriesId: take.seriesId, seriesTitle: take.seriesTitle, aspectRatio: draft.timeline.aspectRatio,
      clipId: take.targetId, scene: take.scene, adopted: null, audioMode: take.audioMode,
    }]);
    apply({ ...draft.timeline, video: [...draft.timeline.video, added] });
    setSelected(added.id);
    setPicking(false);
  });

  const addAudioFromShelf = (track: "sfx" | "music", material: ComicMaterial) => {
    if (!draft || !material.media.durationMs) return;
    const currentLayout = layoutComicTimeline(draft.timeline);
    if (!currentLayout.durationMs) { setError("请先添加视频片段"); return; }
    const offsetMs = position < currentLayout.durationMs ? position : 0;
    const entry = {
      id: crypto.randomUUID(),
      mediaId: material.media.id,
      anchor: { kind: "timeline" as const, offsetMs },
      durationMs: Math.min(material.media.durationMs, currentLayout.durationMs - offsetMs),
      sourceInMs: 0,
      volume: track === "music" ? 0.3 : 1,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: false,
    };
    setExtraAudio(prev => [...prev, { id: material.media.id, durationMs: material.media.durationMs! }]);
    setAudioNames(prev => ({ ...prev, [material.media.id]: material.name }));
    apply({ ...draft.timeline, [track]: [...draft.timeline[track], entry] });
  };

  const openAutoDialoguePreview = useCallback(async (
    targetProject: ComicEdit,
    overridesList?: ComicEditAutoDialogueOverride[],
    nextReplaceNativeIds?: string[],
  ) => {
    setDialogueModalOpen(true);
    setDialogueBusy(true);
    setDialogueError("");
    setDialogueResult(null);
    try {
      const plan = await comicEditApi.previewAutoDialogue(targetProject.id, {
        expectedRevision: targetProject.revision,
        includeVoice: true,
        includeSubtitles: true,
        ...(overridesList?.length ? { overrides: overridesList } : {}),
        ...(nextReplaceNativeIds?.length ? { replaceNativeAudioVideoItemIds: nextReplaceNativeIds } : {}),
      });
      setDialoguePlan(plan);
    } catch (reason) {
      setDialogueError(editError(reason));
    } finally {
      setDialogueBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!autoOpenDialogue || autoOpenedRef.current || !project || !project.timeline.video.length) return;
    autoOpenedRef.current = true;
    onAutoDialogueOpened?.();
    void openAutoDialoguePreview(project, undefined, []);
  }, [autoOpenDialogue, onAutoDialogueOpened, openAutoDialoguePreview, project]);

  const openAutoDialogue = () => {
    if (!project || dirty) return;
    setNotice("");
    setDialogueOverrides({});
    setReplaceNativeIds([]);
    void openAutoDialoguePreview(project, undefined, []);
  };

  const toggleReplaceNative = (videoItemId: string, checked: boolean) => {
    if (!project || dialogueBusy) return;
    const next = checked
      ? [...new Set([...replaceNativeIds, videoItemId])]
      : replaceNativeIds.filter(id => id !== videoItemId);
    setReplaceNativeIds(next);
    void openAutoDialoguePreview(project, Object.values(dialogueOverrides), next);
  };

  const executeAutoDialogue = async (overridesList?: ComicEditAutoDialogueOverride[]) => {
    if (!project || dialogueBusy) return;
    setDialogueBusy(true);
    setDialogueError("");
    try {
      const result = await comicEditApi.autoDialogue(project.id, {
        expectedRevision: project.revision,
        includeVoice: true,
        includeSubtitles: true,
        overflowMode: "ask",
        ...(overridesList?.length ? { overrides: overridesList } : {}),
        ...(replaceNativeIds.length ? { replaceNativeAudioVideoItemIds: replaceNativeIds } : {}),
      });
      receive(result.edit);
      setDialogueResult(result);
      const nextOverrides: Record<string, ComicEditAutoDialogueOverride> = {};
      for (const row of result.items) {
        if (row.status === "overflow" || row.status === "failed") {
          const key = `${row.videoItemId}:${row.lineId}`;
          nextOverrides[key] = {
            videoItemId: row.videoItemId,
            lineId: row.lineId,
            text: row.text,
            speed: row.status === "overflow" && row.suggestedSpeed ? row.suggestedSpeed : row.speed,
          };
        }
      }
      setDialogueOverrides(nextOverrides);
      const mutedSuffix = result.mutedVideoItemIds?.length
        ? ` · ${t("已自动静音 {0} 段原声避免双人声叠加", [result.mutedVideoItemIds.length])}`
        : "";
      setNotice((result.overflowCount > 0 || result.failedCount > 0
        ? t("批量配音已入轨 {0} 句（超长 {1} 句、失败 {2} 句待处理）", [result.voicedCount, result.overflowCount, result.failedCount])
        : t("已批量合成 {0} 句配音、铺设 {1} 条字幕", [result.voicedCount, result.subtitledCount])) + mutedSuffix);
      if (result.overflowCount === 0 && result.failedCount === 0) {
        setDialogueModalOpen(false);
      }
    } catch (reason) {
      setDialogueError(editError(reason));
    } finally {
      setDialogueBusy(false);
    }
  };

  const syncEpisodeTakes = () => void run(async () => {
    const saved = await ensureSaved();
    if (!saved) return;
    const prevCount = saved.timeline.video.length;
    const synced = await comicEditApi.syncEpisode(saved.id, saved.revision);
    receive(synced);
    const addedCount = Math.max(0, synced.timeline.video.length - prevCount);
    setNotice(addedCount > 0
      ? t("已同步 {0} 个本集采用成片到时间线", [addedCount])
      : t("时间线已是本集最新采用片源"));
  });

  if (!project || !draft) return error ? <div className="comic-error" role="alert">
    {t(error)} <button type="button" onClick={reload}>{t("重新读取")}</button>
  </div> : <p role="status">{t("加载中…")}</p>;
  const timeline = draft.timeline;
  const video = timeline.video;
  const item = video.find(item => item.id === selected) ?? video[0];
  const sources = [...project.sources, ...extra];
  const audioSources = [...(project.audioSources ?? []), ...extraAudio];
  const source = sources.find(source => source.takeId === item?.takeId);
  const adopted = source?.adopted;
  const layout = layoutComicTimeline(timeline);
  const locate = (ms: number) => { setPosition(ms); setSeek({ ms }); };
  const normalizeFirst = (entries: Video[]) => entries.map((entry, index) =>
    index === 0 && entry.transitionIn.kind !== "cut" ? { ...entry, transitionIn: { kind: "cut" as const, durationMs: 0 as const } } : entry);
  const move = (from: number, step: number) => {
    const next = [...video];
    [next[from], next[from + step]] = [next[from + step], next[from]];
    apply({ ...timeline, video: normalizeFirst(next) });
  };
  const reorderVideo = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= video.length || to >= video.length) return;
    const next = [...video];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    apply({ ...timeline, video: normalizeFirst(next) });
  };
  const remove = (target: Video) => {
    const remaining = <T extends { anchor: ComicTimeline["voice"][number]["anchor"] }>(items: T[]) =>
      items.filter(entry => entry.anchor.kind !== "clip" || entry.anchor.videoItemId !== target.id);
    const next = { ...timeline, video: normalizeFirst(video.filter(item => item.id !== target.id)), voice: remaining(timeline.voice),
      sfx: remaining(timeline.sfx), music: remaining(timeline.music), subtitles: remaining(timeline.subtitles) };
    if (next.voice.length + next.sfx.length + next.music.length + next.subtitles.length <
      timeline.voice.length + timeline.sfx.length + timeline.music.length + timeline.subtitles.length &&
      !window.confirm(t("移除片段及其配音和依附素材？"))) return;
    apply(next);
  };

  const editorLocked = saving || readOnly;
  const unaddedAdopted = project.unaddedAdoptedTakes ?? [];
  const outdatedAdopted = project.outdatedAdoptedTakes ?? [];
  const episodeClipCount = project.episodeClipCount ?? 0;
  const episodeAdoptedCount = project.episodeAdoptedCount ?? 0;
  const unreadyClips = Math.max(0, episodeClipCount - episodeAdoptedCount);
  const canLeaveStandalone = () => !pending.current && (!dirty || window.confirm(t("放弃未保存的工程修改？")));
  const nextEpisode = (() => {
    const eps = project.dramaEpisodes ?? dramaEpisodesProp ?? [];
    if (!project.seriesId || !eps.length) return null;
    const idx = eps.findIndex(ep => ep.seriesId === project.seriesId);
    if (idx < 0 || idx + 1 >= eps.length) return null;
    const next = eps[idx + 1]!;
    return { episodeNo: next.episodeNo, seriesId: next.seriesId, title: next.title };
  })();

  return <>
    {!embeddedInDramaTask && project.taskKind === "drama" && project.dramaId && (
      <nav className="comic-hierarchy-bar" aria-label={t("剪辑层级路径")}>
        <button type="button" className="comic-hierarchy-btn" onClick={exit}>{t("剪辑工作台")}</button>
        <span className="comic-hierarchy-sep" aria-hidden="true">›</span>
        <div className="comic-hierarchy-tier" data-tier="drama">
          <span className="comic-hierarchy-level">{t("整部剧")}</span>
          {onOpenDramaSelect ? (
            <>
              <button
                type="button"
                className="comic-hierarchy-drama-link"
                onClick={() => onOpenDramaSelect(project.dramaId!)}
              >
                《{project.dramaTitle}》
              </button>
              <button
                type="button"
                className="comic-hierarchy-btn"
                onClick={() => onOpenDramaSelect(project.dramaId!)}
              >
                {t("返回选集（{0} 集）", [project.dramaEpisodes?.length ?? 1])}
              </button>
            </>
          ) : (
            <strong className="comic-hierarchy-name">《{project.dramaTitle}》</strong>
          )}
        </div>
        {(project.dramaEpisodes?.length ?? 0) > 0 && onSwitchEpisode && (
          <>
            <span className="comic-hierarchy-sep" aria-hidden="true">›</span>
            <div className="comic-hierarchy-tier" data-tier="episode">
              <span className="comic-hierarchy-level">{t("具体操作台")}</span>
              <select
                className="comic-hierarchy-select"
                aria-label={t("切换分集操作台")}
                value={project.seriesId ?? ""}
                onChange={event => {
                  const target = event.target.value;
                  if (target && target !== project.seriesId && canLeaveStandalone()) {
                    onSwitchEpisode(project.dramaId!, target);
                  }
                }}
              >
                {project.dramaEpisodes!.map(ep => (
                  <option key={ep.seriesId} value={ep.seriesId}>
                    {t("第 {0} 集（{1}）", [ep.episodeNo, ep.title])}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </nav>
    )}
    <header className="comic-heading">
      <div>
        {!embeddedInDramaTask && project.dramaTitle && project.taskKind !== "drama" && (
          <small className="comic-take-origin">
            {project.dramaTitle}{project.episodeNo ? ` › ${t("第 {0} 集", [project.episodeNo])}` : ""}
            {project.episodeTitle ? ` · ${project.episodeTitle}` : ""}
          </small>
        )}
        <div className="comic-cut-badges">
          {project.taskKind === "drama" ? (
            <small className="comic-pill" data-tone="frame">
              {t("执行单位：第 {0} 集", [project.episodeNo ?? 1])}
            </small>
          ) : (
            <small className="comic-pill" data-tone="idle">{t("自由任务")}</small>
          )}
          <small role="status">{t(readOnly ? "已归档" : saving ? "保存中…" : dirty ? "未保存" : "已保存")}</small>
        </div>
        <h1>
          {project.taskKind === "drama"
            ? t("操作台 - 第 {0} 集（{1}）", [project.episodeNo ?? 1, project.episodeTitle || project.title])
            : project.title}
        </h1>
      </div>
      <div className="comic-actions">
        <button type="button" onClick={() => setShelfOpen(v => !v)}>{t(shelfOpen ? "收起片源架" : "展开片源架")}</button>
        <button type="button" disabled={editorLocked || dirty || !video.length} onClick={openAutoDialogue}>{t("一键配音与字幕")}</button>
        {!embeddedInDramaTask && (
          <button type="button" onClick={exit}>{t("返回剪辑工程列表")}</button>
        )}
        <button type="button" onClick={reload} disabled={saving}>{t("重新读取工程")}</button>
        <button type="button" className="primary" disabled={!dirty || !draft.title.trim() || editorLocked} onClick={save}>{t("保存工程")}</button>
      </div>
    </header>
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    {notice && <p className="comic-generation-note" role="status">{notice}</p>}
    {!picking && project.taskKind === "drama" && !readOnly && (
      <div className="comic-episode-assembly-bar" role="region" aria-label={t("本集分镜合并进度")}>
        <div className="comic-episode-assembly-info">
          <div className="comic-cut-badges">
            <strong>{t("本集分镜汇集")}</strong>
            <small className="comic-pill" data-tone={unaddedAdopted.length === 0 && episodeAdoptedCount > 0 ? "done" : "frame"}>
              {t("时间线 {0} 段 · 分镜已采用 {1}/{2}", [video.length, episodeAdoptedCount, episodeClipCount])}
            </small>
            {unreadyClips > 0 && (
              <small className="comic-pill" data-tone="idle">
                {t("尚有 {0} 个分镜未采用成片", [unreadyClips])}
              </small>
            )}
          </div>
          {unaddedAdopted.length > 0 && (
            <small>
              {t("本集分镜新增 {0} 个已采用成片尚未入轨：{1}", [
                unaddedAdopted.length,
                unaddedAdopted.map(u => `${t("分镜 {0}", [u.ordinal])}${u.scene ? `（${u.scene}）` : ""}`).join("、"),
              ])}
            </small>
          )}
        </div>
        <div className="comic-actions">
          {unaddedAdopted.length > 0 && (
            <button type="button" className="primary" disabled={editorLocked} onClick={syncEpisodeTakes}>
              {t("同步入轨（+{0}）", [unaddedAdopted.length])}
            </button>
          )}
          {outdatedAdopted.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setSelected(outdatedAdopted[0]!.videoItemId);
                setNotice(t("已定位到分镜 {0}，可在视频轨底部替换为最新采用版本", [outdatedAdopted[0]!.ordinal]));
              }}
            >
              {t("待更新版本（{0}）", [outdatedAdopted.length])}
            </button>
          )}
          {unreadyClips > 0 && project.seriesId && onEpisodeProduction && (
            <button
              type="button"
              onClick={() => onEpisodeProduction(project.seriesId!)}
            >
              {t("去分镜补齐")}
            </button>
          )}
          {video.length > 0 && (
            <button
              type="button"
              className={unaddedAdopted.length === 0 ? "primary" : undefined}
              onClick={() => document.getElementById("comic-episode-merge-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              {t("合并成一集剧成果")} ↓
            </button>
          )}
        </div>
      </div>
    )}
    {picking ? <>
      <button type="button" disabled={saving} onClick={() => setPicking(false)}>{t("返回时间线")}</button>
      <ComicVideoHistory picker open={openVideo} choose={choose} />
    </> : <>
      <div className={`comic-edit-fourzone${shelfOpen ? "" : " shelf-collapsed"}`}>
        {shelfOpen && (
          <EditorSourceShelf
            seriesId={project.seriesId}
            disabled={editorLocked || video.length >= 200}
            inTimelineTakeIds={new Set(video.map(v => v.takeId))}
            addTake={choose}
            addAudio={addAudioFromShelf}
            browseAll={() => setPicking(true)}
          />
        )}
        <ComicTrimmedPreview timeline={timeline} sources={sources} audioSources={audioSources}
          seek={seek} position={position} onPosition={setPosition} />
        <section className="comic-edit-card">
          <header><h2>{t("视频轨")}</h2><strong>{t("总时长 {0} 秒", [seconds(layout.durationMs)])}</strong></header>
          <fieldset disabled={editorLocked} className="comic-editor-fields">
            <label>
              {t(project.taskKind === "drama" ? "本集剪辑名称" : "工程名称")}
              <input value={draft.title} maxLength={120} onChange={event => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <div className="comic-actions"><button type="button" onClick={() => setPicking(true)} disabled={editorLocked || video.length >= 200}>{t("添加片源")}</button></div>
            <ol className="comic-video-track">{video.map((entry, index) => {
              const meta = sources.find(source => source.takeId === entry.takeId);
              return <li key={entry.id}
                draggable={!saving}
                onDragStart={event => {
                  draggingIndex.current = index;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", entry.id);
                }}
                onDragEnd={() => { draggingIndex.current = null; }}
                onDragOver={event => { if (!saving && draggingIndex.current !== null) event.preventDefault(); }}
                onDrop={event => {
                  event.preventDefault();
                  if (draggingIndex.current !== null) reorderVideo(draggingIndex.current, index);
                  draggingIndex.current = null;
                }}>
                <button className="comic-track-label" type="button" aria-pressed={item?.id === entry.id} onClick={() => setSelected(entry.id)}>
                  <strong>{meta?.scene || meta?.seriesTitle || t("片源不可用，请重新选择")}</strong>
                  <small>
                    {meta?.dramaTitle ? `${meta.dramaTitle} › ` : ""}
                    {meta?.episodeNo ? `${t("第 {0} 集", [meta.episodeNo])} › ` : ""}
                    {meta?.clipOrdinal ? `${t("分镜 {0}", [meta.clipOrdinal])} · ` : ""}
                    {meta?.seriesTitle} · {t("版本 {0}", [meta?.version ?? "—"])} · {t("{0} 秒", [seconds(entry.outMs - entry.inMs)])}
                    {meta?.audioMode === "native_audio" ? ` · ${t("原生音画")}` : meta?.audioMode === "reference_audio" ? ` · ${t("参考音频")}` : ""}
                  </small>
                </button>
                <div className="comic-actions">
                  <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>{t("上移")}</button>
                  <button type="button" disabled={index + 1 === video.length} onClick={() => move(index, 1)}>{t("下移")}</button>
                  <button type="button" onClick={() => remove(entry)}>{t("移除")}</button>
                </div>
              </li>;
            })}</ol>
            {item && source?.seriesId && source.clipId && (
              <div className="comic-actions">
                <button type="button" onClick={() => openVideo(source.seriesId!, source.clipId!)}>{t("重新生成")}</button>
              </div>
            )}
            {item && <TrimFields key={item.id + ":" + item.inMs + ":" + item.outMs + ":" + item.takeId} item={item}
              apply={(inMs, outMs) => apply({ ...timeline, video: video.map(entry => entry.id === item.id ? { ...entry, inMs, outMs } : entry) })} />}
            {item && <VideoProperties key={JSON.stringify(item)} item={item} first={video[0]?.id === item.id}
              change={next => apply({ ...timeline, video: video.map(entry => entry.id === item.id ? next : entry) })} />}
            {item && adopted && adopted.takeId !== item.takeId && <div className="comic-actions">
              <button type="button" disabled={dirty} onClick={() => setReplacement(true)}>{t("替换为采用版（版本 {0}）", [adopted.version])}</button>
              {dirty && <small>{t("保存工程后可替换片源")}</small>}
            </div>}
          </fieldset>
        </section>
      </div>
      <ComicTimelineTracks timeline={timeline} videoSources={sources} audioSources={audioSources} audioNames={audioNames}
        selectedVideo={item?.id} positionMs={position} seek={locate} selectVideo={setSelected} update={apply} disabled={editorLocked}
        canUndo={history.past.length > 0} canRedo={history.future.length > 0} onUndo={undo} onRedo={redo}
        onInteractingChange={setInteracting} onPreviewTemp={() => setTempPreviewOpen(true)} />
      {item && project.timeline.video.some(saved => saved.id === item.id && saved.takeId === item.takeId) &&
        <ComicDialogueAudio key={item.id + item.takeId} projectId={id} revision={project.revision} item={item} audioMode={source?.audioMode}
          voice={timeline.voice}
          change={(voice, opts) => apply({
            ...timeline,
            voice,
            ...(opts?.muteVideo ? { video: video.map(entry => entry.id === item.id ? { ...entry, volume: 0 } : entry) } : {}),
          })}
          subtitles={timeline.subtitles}
          addSubtitle={cue => apply({ ...timeline, subtitles: [...timeline.subtitles, cue] })} disabled={editorLocked} />}
      <ComicRenderPanel
        project={project}
        dirty={dirty || saving}
        readOnly={readOnly}
        draftTimeline={timeline}
        nextEpisode={nextEpisode}
        onEnsureSaved={ensureSaved}
        onRenderUpdated={onRenderUpdated}
        onSwitchNextEpisode={project.dramaId && onSwitchEpisode
          ? epId => { if (canLeaveStandalone()) onSwitchEpisode(project.dramaId!, epId); }
          : undefined}
        onBackToSelect={project.dramaId && onOpenDramaSelect
          ? () => onOpenDramaSelect(project.dramaId!)
          : undefined}
      />
    </>}
    {replacement && item && adopted && <LibraryDialog title={t("替换为采用版（版本 {0}）", [adopted.version])} submitLabel={t("确认替换")}
      close={() => setReplacement(false)} describeError={editError} save={async (form, signal) => {
        const outMs = item.outMs > adopted.durationMs ? Math.round(Number(form.get("out")) * 1000) : item.outMs;
        receive(await comicEditApi.replace(id, item.id, { expectedRevision: project.revision, takeId: adopted.takeId, outMs }, signal));
      }}>
      {item.outMs > adopted.durationMs ? <>
        <p>{t("新版短于当前出点。请确认新的出点。")}</p>
        <label>{t("出点（秒）")}<input name="out" type="number" min={(item.inMs + 1) / 1000} max={adopted.durationMs / 1000}
          step={0.001} required defaultValue={seconds(adopted.durationMs)} /></label>
      </> : <p>{t("替换后保留当前入点和出点。")}</p>}
    </LibraryDialog>}
    {dialogueModalOpen && (
      <BatchDialogueDialog
        plan={dialoguePlan}
        result={dialogueResult}
        overrides={dialogueOverrides}
        replaceNativeIds={replaceNativeIds}
        busy={dialogueBusy}
        error={dialogueError}
        toggleReplaceNative={toggleReplaceNative}
        updateOverride={(key, patch) => setDialogueOverrides(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }))}
        confirm={() => void executeAutoDialogue()}
        retry={() => void executeAutoDialogue(Object.values(dialogueOverrides))}
        close={() => { if (!dialogueBusy) setDialogueModalOpen(false); }}
      />
    )}
    {tempPreviewOpen && (
      <ComicTempPreviewDialog
        aspectRatio={timeline.aspectRatio}
        ensureSaved={ensureSaved}
        fixOverflowAndSave={readOnly ? undefined : fixOverflowAndSave}
        close={() => setTempPreviewOpen(false)}
      />
    )}
  </>;
}

function BatchDialogueDialog({
  plan, result, overrides, replaceNativeIds, busy, error, toggleReplaceNative, updateOverride, confirm, retry, close,
}: {
  plan: ComicAutoDialoguePlan | null;
  result: ComicAutoDialogueResult | null;
  overrides: Record<string, ComicEditAutoDialogueOverride>;
  replaceNativeIds: string[];
  busy: boolean;
  error: string;
  toggleReplaceNative: (videoItemId: string, checked: boolean) => void;
  updateOverride: (key: string, patch: Partial<ComicEditAutoDialogueOverride>) => void;
  confirm: () => void;
  retry: () => void;
  close: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const affected = (result?.items ?? []).filter(item => item.status === "overflow" || item.status === "failed");
  const statusLabel = (status: ComicAutoDialoguePlan["lines"][number]["status"]) => {
    switch (status) {
      case "already_placed": return "已入轨";
      case "cached": return "缓存命中";
      case "to_synthesize": return "待新合成";
      case "native_audio_subtitle_only": return "原生音画仅铺字幕";
      case "unknown_blocked": return "待核实阻断";
      case "compliance_blocked": return "合规拦截";
      case "no_voice": return "暂无可用音色";
      default: return "无剩余时长";
    }
  };
  return <dialog ref={dialogRef} className="comic-dialog comic-quote" aria-label={t("批量配音范围核对")} onCancel={event => {
    event.preventDefault();
    close();
  }}>
    <h2>{t(result ? "批量配音结果与异常处理" : "批量配音范围核对")}</h2>
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    {!result ? (
      !plan ? <p role="status">{t("正在核对配音范围…")}</p> : <>
        <div className="comic-episode-stats">
          <span>{t("共 {0} 句台词", [plan.totalLines])}</span>
          <span>{t("缓存命中 {0} 句", [plan.cachedCount])}</span>
          <span>{t("待新合成 {0} 句", [plan.toSynthesizeCount])}</span>
          {(plan.nativeAudioSkippedCount ?? 0) > 0 && <span>{t("原生音画跳过配音 {0} 句", [plan.nativeAudioSkippedCount ?? 0])}</span>}
          {plan.blockedCount > 0 && <span>{t("阻断 {0} 句", [plan.blockedCount])}</span>}
          {plan.overflowCount > 0 && <span>{t("预计超长 {0} 句", [plan.overflowCount])}</span>}
        </div>
        {!!plan.nativeAudioClips?.length && (
          <div className="comic-compat-box">
            <strong>{t("含原生／参考音频的片段（默认仅铺字幕，不重复合成配音）")}</strong>
            <ul>
              {plan.nativeAudioClips.map(clip => (
                <li key={clip.videoItemId}>
                  <span>
                    {clip.scene || t("未命名分镜")} · {t(clip.audioMode === "native_audio" ? "原生音画" : "参考音频")}
                    {" · "}{t("{0} 句台词", [clip.lineCount])}
                  </span>
                  <label className="comic-video-replace">
                    <input type="checkbox" disabled={busy} checked={replaceNativeIds.includes(clip.videoItemId)}
                      onChange={event => toggleReplaceNative(clip.videoItemId, event.target.checked)} />
                    {t("改用后期配音（自动静音原声）")}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="comic-generation-note">
          {plan.feeStatus === "free_cached"
            ? t("本次无需新增合成费用。")
            : t("新合成预计 {0} 积分。", [plan.estimatedPoints])}
        </p>
        <ul className="comic-dialogue-batch-list">
          {plan.lines.map(line => (
            <li key={`${line.videoItemId}:${line.lineId}`}>
              <div>
                <strong>{line.speaker ? `${line.speaker} · ` : ""}{line.text}</strong>
                <small>{t(statusLabel(line.status))} · {t("剩余 {0} 秒", [+(line.remainingMs / 1000).toFixed(2)])}
                  {line.overflowMs ? ` · ${t("超出 {0} 秒", [+(line.overflowMs / 1000).toFixed(2)])}` : ""}</small>
              </div>
            </li>
          ))}
        </ul>
        <div className="comic-actions comic-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>{t("取消")}</button>
          <button type="button" className="primary" disabled={busy || plan.totalLines === 0} onClick={confirm}>
            {t(busy ? "正在合成…" : "确认并执行批量配音")}
          </button>
        </div>
      </>
    ) : <>
      <div className="comic-episode-stats">
        <span>{t("已入轨 {0} 句", [result.voicedCount])}</span>
        <span>{t("复用缓存 {0} 句", [result.cachedCount])}</span>
        <span>{t("新合成 {0} 句", [result.synthesizedCount])}</span>
        {result.overflowCount > 0 && <span>{t("超长待处理 {0} 句", [result.overflowCount])}</span>}
        {result.failedCount > 0 && <span>{t("失败 {0} 句", [result.failedCount])}</span>}
      </div>
      <p className="comic-generation-note">{t("已成功的音频与轨道已保存，重试时将直接复用缓存，不会重复计费。")}</p>
      <ul className="comic-dialogue-batch-list">
        {affected.map(item => {
          const key = `${item.videoItemId}:${item.lineId}`;
          const ov = overrides[key] ?? { videoItemId: item.videoItemId, lineId: item.lineId, text: item.text, speed: item.speed };
          return <li key={key}>
            <div className="comic-dialogue-issue-row">
              <strong>{item.speaker ? `${item.speaker} · ` : ""}{item.text}</strong>
              {item.status === "overflow" ? (
                <>
                  <small>{t("合成时长 {0} 秒超出剩余 {1} 秒，请选择裁切、改词或调速", [
                    +((item.audioDurationMs ?? 0) / 1000).toFixed(2),
                    +((item.remainingMs ?? 0) / 1000).toFixed(2),
                  ])}</small>
                  <div className="comic-actions">
                    <label className="comic-video-replace">
                      <input type="checkbox" checked={ov.overflowAction === "trim"}
                        onChange={e => updateOverride(key, { overflowAction: e.target.checked ? "trim" : undefined })} />
                      {t("裁切并入轨（复用缓存）")}
                    </label>
                    <label>{t("调速")}
                      <select value={ov.speed ?? item.speed} disabled={ov.overflowAction === "trim"}
                        onChange={e => updateOverride(key, { speed: Number(e.target.value) })}>
                        {[...new Set([0.75, 1, 1.25, 1.5, 1.75, 2, ...(item.suggestedSpeed ? [item.suggestedSpeed] : [])])]
                          .sort((a, b) => a - b)
                          .map(val => <option key={val} value={val}>{val}×</option>)}
                      </select>
                    </label>
                  </div>
                  <label>{t("改词")}
                    <input maxLength={1000} disabled={ov.overflowAction === "trim"} value={ov.text ?? item.text}
                      onChange={e => updateOverride(key, { text: e.target.value })} />
                  </label>
                </>
              ) : (
                <>
                  <small className="comic-error">{t(editError(new ApiClientError(item.errorCode ?? "FAILED", 400, item.errorCode)))}</small>
                  <label>{t("改词")}
                    <input maxLength={1000} value={ov.text ?? item.text}
                      onChange={e => updateOverride(key, { text: e.target.value })} />
                  </label>
                </>
              )}
            </div>
          </li>;
        })}
      </ul>
      <div className="comic-actions comic-dialog-actions">
        <button type="button" disabled={busy} onClick={close}>{t("关闭")}</button>
        {affected.length > 0 && (
          <button type="button" className="primary" disabled={busy} onClick={retry}>
            {t(busy ? "正在重试…" : "按调整项重试")}
          </button>
        )}
      </div>
    </>}
  </dialog>;
}

function VideoProperties({ item, first, change }: { item: Video; first: boolean; change: (item: Video) => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState(item.transitionIn.kind);
  return <form className="comic-overlay-fields" onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const transitionIn: Video["transitionIn"] = kind === "cut" || first ? { kind: "cut", durationMs: 0 }
      : { kind, durationMs: Math.round(Number(form.get("transition")) * 1000) };
    change({ ...item, transitionIn, volume: Number(form.get("volume")) / 100 });
  }}>
    {!first && <label>{t("入场转场")}<select aria-label={t("入场转场")} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="cut">{t("直接切换")}</option><option value="crossfade">{t("交叠淡入淡出")}</option><option value="black">{t("黑场过渡")}</option>
    </select></label>}
    {!first && kind !== "cut" && <label>{t("转场（秒）")}<input type="number" name="transition" min={0.001}
      max={(item.outMs - item.inMs - 1) / 1000} required step={0.001} defaultValue={item.transitionIn.durationMs / 1000 || 0.5} /></label>}
    <label>{t("片源音量（%）")}<input type="number" name="volume" min={0} max={200} required defaultValue={Math.round(item.volume * 100)} /></label>
    <button type="submit">{t("应用片段设置")}</button>
  </form>;
}

function TrimFields({ item, apply }: { item: Video; apply: (inMs: number, outMs: number) => void }) {
  const { t } = useI18n();
  return <form className="comic-trim-controls" onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    apply(Math.round(Number(data.get("in")) * 1000), Math.round(Number(data.get("out")) * 1000));
  }}>
    <label>{t("入点（秒）")}<input name="in" type="number" required min={0} max={(item.sourceDurationMs - 1) / 1000}
      step={0.001} defaultValue={seconds(item.inMs)} /></label>
    <label>{t("出点（秒）")}<input name="out" type="number" required min={0.001} max={item.sourceDurationMs / 1000}
      step={0.001} defaultValue={seconds(item.outMs)} /></label>
    <button type="submit">{t("应用裁切")}</button>
  </form>;
}

function EditorSourceShelf({ seriesId, disabled, inTimelineTakeIds, addTake, addAudio, browseAll }: {
  seriesId: string | null;
  disabled: boolean;
  inTimelineTakeIds?: ReadonlySet<string>;
  addTake: (takeId: string) => void;
  addAudio: (track: "sfx" | "music", material: ComicMaterial) => void;
  browseAll: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"adopted" | "history" | "audio">(seriesId ? "adopted" : "history");
  const [takes, setTakes] = useState<ComicVideoTake[] | null>(null);
  const [audio, setAudio] = useState<{ sfx: ComicMaterial[]; music: ComicMaterial[] } | null>(null);

  useEffect(() => {
    if (tab === "audio") {
      const controller = new AbortController();
      void Promise.all([
        comicLibraryApi.materials({ kind: "sound", page: "1" }, controller.signal),
        comicLibraryApi.materials({ kind: "music", page: "1" }, controller.signal),
      ]).then(([sfxRes, musicRes]) => {
        if (!controller.signal.aborted) setAudio({ sfx: sfxRes.entries, music: musicRes.entries });
      }).catch(() => { if (!controller.signal.aborted) setAudio({ sfx: [], music: [] }); });
      return () => controller.abort();
    }
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (tab === "adopted" && seriesId) { params.set("seriesId", seriesId); params.set("adopted", "true"); }
    setTakes(null);
    void comicGenerationApi.videoHistory(params, controller.signal).then(res => {
      if (!controller.signal.aborted) setTakes(res.entries);
    }).catch(() => { if (!controller.signal.aborted) setTakes([]); });
    return () => controller.abort();
  }, [tab, seriesId]);

  return (
    <aside className="comic-edit-card comic-source-shelf" aria-label={t("片源架")}>
      <header>
        <h2>{t("片源架")}</h2>
        <button type="button" onClick={browseAll}>{t("全部片源")}</button>
      </header>
      <div className="comic-actions comic-shelf-tabs" role="tablist">
        {seriesId && <button type="button" role="tab" aria-selected={tab === "adopted"} onClick={() => setTab("adopted")}>{t("本集采用")}</button>}
        <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>{t("历史成片")}</button>
        <button type="button" role="tab" aria-selected={tab === "audio"} onClick={() => setTab("audio")}>{t("音效与配乐")}</button>
      </div>
      {tab === "audio" ? (
        audio === null ? <p role="status">{t("加载中…")}</p> : (
          <div className="comic-shelf-list">
            <h3>{t("音效")}</h3>
            {audio.sfx.length === 0 ? <small>{t("暂无音效素材")}</small> : audio.sfx.map(mat => (
              <div key={mat.id} className="comic-shelf-item">
                <span>{mat.name}</span>
                <button type="button" disabled={disabled || !mat.media.durationMs} onClick={() => addAudio("sfx", mat)}>＋ {t("入轨")}</button>
              </div>
            ))}
            <h3>{t("背景音乐")}</h3>
            {audio.music.length === 0 ? <small>{t("暂无音乐素材")}</small> : audio.music.map(mat => (
              <div key={mat.id} className="comic-shelf-item">
                <span>{mat.name}</span>
                <button type="button" disabled={disabled || !mat.media.durationMs} onClick={() => addAudio("music", mat)}>＋ {t("入轨")}</button>
              </div>
            ))}
          </div>
        )
      ) : (
        takes === null ? <p role="status">{t("加载中…")}</p> : takes.length === 0 ? <p className="comic-generation-note">{t("暂无匹配的成片")}</p> : (
          <div className="comic-shelf-list">
            {takes.slice(0, 20).map(take => {
              const inTrack = inTimelineTakeIds?.has(take.id) ?? false;
              return (
                <div key={take.id} className="comic-shelf-item">
                  <div>
                    <strong>{take.ordinal !== null ? t("分镜 {0}", [take.ordinal]) + " · " : ""}{take.scene || take.seriesTitle}</strong>
                    <small>
                      {take.dramaTitle ? `${take.dramaTitle} · ` : ""}
                      {take.episodeNo ? `${t("第 {0} 集", [take.episodeNo])} · ` : ""}
                      {t("版本 {0}", [take.version])} · {t("{0} 秒", [+(take.durationMs / 1000).toFixed(1)])}
                      {inTrack ? ` · ${t("已在轨")}` : ""}
                    </small>
                  </div>
                  <button type="button" disabled={disabled} onClick={() => addTake(take.id)}>＋ {t("入轨")}</button>
                </div>
              );
            })}
          </div>
        )
      )}
    </aside>
  );
}
