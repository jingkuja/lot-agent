import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkComicClipIssues, COMIC_DRAMA_ROOT,
  type ComicCurrencyAmount, type ComicDirectorApplyInput, type ComicDirectorDecision, type ComicDirectorProposal,
  type ComicDirectorRoleOutcome, type ComicDrama, type ComicDramaContent, type ComicDramaCreateInput, type ComicDramaDetail,
  type ComicDramaEpisodeSummary, type ComicDramaScriptVersion, type ComicDramaSeriesInput, type ComicDramaTreeEntry,
  type ComicDramaUpdateInput, type ComicGenerationMode,
} from "@lot-agent/core/comic-drama";
import { ApiClientError, type User } from "../../api/client.js";
import { BrandHeader } from "../../components/BrandHeader.js";
import { useI18n } from "../../i18n/index.js";
import { comicDramaApi } from "./api.js";
import { computeComicBatchPlan } from "./batch-plan.js";
import { ComicClipOriginBadge, ComicWorkspaceHierarchyBar } from "./ComicHierarchyBar.js";
import { DramaDialog } from "./DramaDialog.js";
import { SeriesDialog, type ComicDramaModel, type PresetDramaTarget } from "./SeriesDialog.js";
import { SeriesHistory } from "./SeriesHistory.js";
import { CastPanel } from "./CastPanel.js";
import { MediaPreview, useComicChoices } from "./LibraryParts.js";
import { CharacterLibrary } from "./CharacterLibrary.js";
import { MaterialLibrary } from "./MaterialLibrary.js";
import { ComicSettingsPage } from "./ComicSettingsPage.js";
import { Storyboard } from "./Storyboard.js";
import { ComicImageGeneration } from "./ComicImageGeneration.js";
import { ComicVideoHistory } from "./ComicVideoHistory.js";
import { ComicEditorSource } from "./ComicEditorSource.js";
import { ComicEditsIndex } from "./ComicEditList.js";
import { ComicEditWorkspace } from "./ComicEditWorkspace.js";
import { ComicDirectorPanel } from "./ComicDirectorPanel.js";
import type { DirectorEnhanceIntent } from "./ComicEnhanceProposal.js";
import type { DirectorRoleChoiceInput } from "./DirectorConfirmations.js";
import { ComicRenderPanel } from "./ComicRenderPanel.js";
import { ComicStudioLanding } from "./ComicStudioLanding.js";
import { ComicEpisodeBudgetDialog } from "./ComicEpisodeBudgetDialog.js";
import { ComicVideoCreditPauses } from "./ComicVideoCreditPauses.js";
import {
  CharactersIcon, ClapperboardIcon, EpisodesIcon, ExportBoxIcon, MaterialsIcon, NewEpisodeIcon,
  ScriptIcon, SettingsIcon, SparklesIcon, StoryboardIcon, TimelineEditIcon, VideoReelIcon,
} from "./ComicStudioIcons.js";
import { comicDirectorApi } from "./director-api.js";
import { useComicDramaDraft } from "./useComicDramaDraft.js";
import "./comic-drama.css";

const historyPath = COMIC_DRAMA_ROOT + "/series";
const seriesPath = (id: string) => historyPath + "/" + id;

type Props = {
  user: User;
  pathname: string;
  active: boolean;
  navigate: (path: string) => void;
  replacePath: (path: string) => void;
  onOpenAssistant: () => void;
  onOpenDigitalEmployee: () => void;
  onLogout: () => void;
  models: readonly ComicDramaModel[];
  imageModels?: readonly ComicDramaModel[];
};

const steps = [
  { key: "剧本", Icon: ScriptIcon },
  { key: "选角", Icon: CharactersIcon },
  { key: "分镜", Icon: StoryboardIcon },
  { key: "生成", Icon: SparklesIcon },
  { key: "剪辑", Icon: TimelineEditIcon },
] as const;
const libraryPaths = [
  { suffix: "/characters", label: "角色素材库", tone: "violet", Icon: CharactersIcon },
  { suffix: "/materials", label: "素材库", tone: "azure", Icon: MaterialsIcon },
  { suffix: "/settings", label: "设置", tone: "slate", Icon: SettingsIcon },
] as const;
const videosPath = COMIC_DRAMA_ROOT + "/clips";
const editorPath = COMIC_DRAMA_ROOT + "/editor";
const editorSourcesPath = editorPath + "/sources";
const editorSourcePrefix = editorSourcesPath + "/";
const renderHistoryPath = editorPath + "/exports";
const legacyProjectPrefix = editorPath + "/projects/";

function formatMicros(micros: number, currency: "CNY" | "USD") {
  const symbol = currency === "USD" ? "$" : "¥";
  const amount = micros / 1_000_000;
  return `${symbol}${amount === 0 ? "0" : amount.toFixed(amount < 0.01 ? 4 : 2)}`;
}

function formatCurrencyList(entries: readonly ComicCurrencyAmount[]): string {
  return entries.map(entry => formatMicros(entry.amountMicros, entry.currency)).join(" + ");
}

export function ComicDramaWorkspace({
  user, pathname, active, navigate, replacePath, onOpenAssistant, onOpenDigitalEmployee, onLogout,
  models, imageModels = [],
}: Props) {
  const { t, locale } = useI18n();
  const styles = useComicChoices("style");
  const { editor, load, flush, editClip, editScript, reapply, dirty, getDetail } = useComicDramaDraft();
  const detail = editor.detail;
  const series = detail?.series;
  const [sidebarSummary, setSidebarSummary] = useState<ComicDramaEpisodeSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [bgNotice, setBgNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "edit" | "addEpisode" | null>(null);
  const [presetDrama, setPresetDrama] = useState<PresetDramaTarget | undefined>(undefined);
  const [dramaDialog, setDramaDialog] = useState<{ mode: "create" | "edit"; drama?: ComicDrama } | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [budgetSeriesId, setBudgetSeriesId] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [stage, setStage] = useState<"剧本" | "选角" | "分镜" | "生成">("分镜");
  const [openVideos, setOpenVideos] = useState(false);
  const [quickAction, setQuickAction] = useState<{ mode: ComicGenerationMode; token: number } | null>(null);
  const editStoryboardClip = (clipId: string) => { setSelected(clipId); setStage("分镜"); };
  const [selected, setSelected] = useState<string | null>(null);
  const [latest, setLatest] = useState<ComicDramaDetail | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerTab, setDrawerTab] = useState<"detail" | "director">("director");
  const [enhanceIntent, setEnhanceIntent] = useState<DirectorEnhanceIntent | null>(null);
  const [scriptSelection, setScriptSelection] = useState<{ start: number; end: number } | null>(null);
  const clearEnhanceIntent = useCallback(() => setEnhanceIntent(null), []);
  const [pendingAutoDialogueEditId, setPendingAutoDialogueEditId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const routeQueue = useRef<Promise<void>>(Promise.resolve());
  const loadedPath = useRef(COMIC_DRAMA_ROOT);
  const history = pathname === historyPath;
  const videoHistory = pathname === videosPath;
  const legacyEditId = pathname.startsWith(legacyProjectPrefix) ? pathname.slice(legacyProjectPrefix.length) : "";
  const pickingSource = pathname === editorSourcesPath;
  const renderHistory = pathname === renderHistoryPath;
  const takeId = pathname.startsWith(editorSourcePrefix) ? pathname.slice(editorSourcePrefix.length) : "";
  const editId = !legacyEditId && !pickingSource && !renderHistory && !takeId && pathname.startsWith(editorPath + "/")
    ? pathname.slice(editorPath.length + 1) : "";
  const editorRoute = pathname === editorPath || pathname.startsWith(editorPath + "/");
  const editGuard = useRef<(() => boolean) | null>(null);
  const setEditGuard = useCallback((guard: (() => boolean) | null) => { editGuard.current = guard; }, []);
  const directId = pathname.startsWith(historyPath + "/") ? pathname.slice(historyPath.length + 1) : null;
  const library = libraryPaths.find(({ suffix }) => pathname === COMIC_DRAMA_ROOT + suffix ||
    (suffix === "/characters" && pathname.startsWith(COMIC_DRAMA_ROOT + suffix + "/")))?.suffix;
  const characterId = library === "/characters" ? pathname.split("/")[3] : undefined;
  const workspace = !history && !editorRoute && !library && !videoHistory;
  const locked = !!series?.archivedAt || busy;

  // Redirect legacy /comic-drama/editor/projects/:editId to aligned /comic-drama/editor/:editId
  useEffect(() => {
    if (active && legacyEditId) replacePath(editorPath + "/" + legacyEditId);
  }, [active, legacyEditId, replacePath]);

  // Always keep sidebar's current series summary populated, even on direct subroutes
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void comicDramaApi.currentSummary(controller.signal).then(res => {
      if (!controller.signal.aborted) setSidebarSummary(res.summary);
    }).catch(() => {});
    return () => controller.abort();
  }, [active, pathname, retry]);

  useEffect(() => {
    if (detail?.summary && !detail.series.archivedAt) {
      setSidebarSummary(detail.summary);
    }
  }, [detail?.series.archivedAt, detail?.summary]);

  useEffect(() => {
    setScriptSelection(null);
  }, [series?.id]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
    setNotice(null);
    routeQueue.current = routeQueue.current.then(async () => {
      if (!live) return;
      if (!await flush()) {
        if (live && pathname !== loadedPath.current) replacePath(loadedPath.current);
        return;
      }
      if (!live || !workspace) return;
      const id = directId ?? (await comicDramaApi.current(controller.signal)).seriesId;
      if (!live) return;
      let result = id ? await comicDramaApi.get(id, controller.signal) : null;
      if (directId && result && !result.series.archivedAt && live) result = await comicDramaApi.open(directId);
      if (live) {
        loadedPath.current = pathname;
        setLatest(null);
        load(result);
        if (result?.summary && !result.series.archivedAt) setSidebarSummary(result.summary);
      }
    }).catch(() => { if (live) setLoadError(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [active, directId, flush, getDetail, load, pathname, replacePath, retry, workspace]);

  const leave = async (callback: () => void) => {
    if (!busyRef.current && (editGuard.current?.() ?? true) && await flush()) callback();
  };
  const warnGeneratingIfSwitching = (targetId?: string) => {
    const activeSum = detail?.summary ?? sidebarSummary;
    if (activeSum && activeSum.generatingCount > 0 && (!targetId || activeSum.seriesId !== targetId)) {
      setBgNotice(t("当前剧集仍有 {0} 个成片在生成，会在后台继续", [activeSum.generatingCount]));
    } else {
      setBgNotice(null);
    }
  };
  const handleError = (error: unknown) => {
    if (error instanceof ApiClientError && error.code === "MODEL_UNAVAILABLE") return t("视频模型不可用，请重新选择");
    if (error instanceof ApiClientError && error.code === "DIRECTOR_PROPOSAL_STALE") return t("剧集已更新，请基于最新修订生成提案");
    if (error instanceof ApiClientError && error.status === 409) return t("剧集已更新，请读取最新版本");
    return t("操作失败，请重试");
  };
  async function run(operation: () => Promise<void>, report = setNotice) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    report(null);
    try {
      if (!await flush()) return false;
      await operation();
      return true;
    } catch (error) {
      report(handleError(error));
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }
  const saved = (result: ComicDramaDetail) => {
    warnGeneratingIfSwitching(result.series.id);
    load(result);
    if (result.summary && !result.series.archivedAt) setSidebarSummary(result.summary);
    loadedPath.current = seriesPath(result.series.id);
    navigate(loadedPath.current);
  };
  const reloadCurrent = useCallback(async () => {
    const current = getDetail();
    if (!current) return;
    try {
      const fresh = await comicDramaApi.get(current.series.id);
      load(fresh);
      if (fresh.summary && !fresh.series.archivedAt) setSidebarSummary(fresh.summary);
    } catch { /* ignore */ }
  }, [getDetail, load]);
  const changeContent = (apply: (id: string, revision: number) => Promise<ComicDramaContent>, then?: (result: ComicDramaContent) => void) =>
    run(async () => {
      const current = getDetail();
      if (!current) return;
      const result = await apply(current.series.id, current.series.revision);
      const refreshed = await comicDramaApi.get(current.series.id).catch(() => null);
      if (refreshed) load(refreshed);
      else load({ ...current, series: { ...current.series, revision: result.seriesRevision }, script: result.script, clips: result.clips, cast: result.cast });
      then?.(result);
    });
  const showDialog = (next: "create" | "edit" | "addEpisode", preset?: PresetDramaTarget) => void leave(() => {
    setModalError(null);
    setPresetDrama(preset);
    setDialog(next);
  });
  const showDramaDialog = (mode: "create" | "edit", drama?: ComicDrama) => void leave(() => {
    setModalError(null);
    setDramaDialog({ mode, drama });
  });
  const saveDialog = (fields: ComicDramaSeriesInput) => run(async () => {
    const current = getDetail();
    if (dialog === "edit" && current) {
      const updated = await comicDramaApi.update(current.series.id, fields, current.series.revision);
      const fresh = await comicDramaApi.get(updated.id).catch(() => null);
      if (fresh) {
        load(fresh);
        if (fresh.summary && !fresh.series.archivedAt) setSidebarSummary(fresh.summary);
      } else {
        load({ ...current, series: updated });
        if (sidebarSummary?.seriesId === updated.id) {
          setSidebarSummary({ ...sidebarSummary, title: updated.title, episodeNo: updated.episodeNo ?? 1 });
        }
      }
      setHistoryRefresh(v => v + 1);
    } else if (dialog === "addEpisode" && presetDrama) {
      const created = await comicDramaApi.createEpisode(presetDrama.id, fields);
      setHistoryRefresh(v => v + 1);
      saved(created);
    } else {
      const created = await comicDramaApi.create(fields);
      setHistoryRefresh(v => v + 1);
      saved(created);
    }
  }, setModalError);

  const saveDramaDialog = (fields: ComicDramaCreateInput | ComicDramaUpdateInput) => run(async () => {
    if (dramaDialog?.mode === "edit" && dramaDialog.drama) {
      await comicDramaApi.updateDrama(dramaDialog.drama.id, fields as ComicDramaUpdateInput);
      const current = getDetail();
      if (current && current.series.dramaId === dramaDialog.drama.id) {
        const fresh = await comicDramaApi.get(current.series.id).catch(() => null);
        if (fresh) {
          load(fresh);
          if (fresh.summary && !fresh.series.archivedAt) setSidebarSummary(fresh.summary);
        }
      }
      setHistoryRefresh(v => v + 1);
    } else {
      const created = await comicDramaApi.createDrama(fields as ComicDramaCreateInput);
      setHistoryRefresh(v => v + 1);
      if (created.detail) saved(created.detail);
    }
  }, setModalError);

  const commitInlineTitle = () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (!series || !trimmed || trimmed === series.title) return;
    void run(async () => {
      const current = getDetail();
      if (!current) return;
      const updated = await comicDramaApi.update(current.series.id, {
        title: trimmed, logline: current.series.logline, seriesGroup: current.series.seriesGroup,
        episodeNo: current.series.episodeNo, styleKey: current.series.styleKey,
        aspectRatio: current.series.aspectRatio, videoModel: current.series.videoModel,
      }, current.series.revision);
      load({ ...current, series: updated });
      if (sidebarSummary?.seriesId === updated.id) setSidebarSummary({ ...sidebarSummary, title: updated.title });
    });
  };

  const checkLatest = async () => {
    if (!series) return;
    try { setLatest(await comicDramaApi.get(series.id)); }
    catch { setNotice(t("读取最新版本失败，请重试")); }
  };
  const issueClip = latest?.clips.find(clip => clip.id === editor.issue?.target);
  const issueIsScript = editor.issue?.target === "script";
  const openVideo = (id: string, clipId: string) => void leave(() => {
    setSelected(clipId); setOpenVideos(true); setStage("生成"); navigate(seriesPath(id));
  });
  const choose = (id: string) => void leave(() => navigate(editorSourcePrefix + id));
  const openEdit = (id: string) => navigate(editorPath + "/" + id);
  const applyProposal = async (
    proposal: ComicDirectorProposal,
    decision?: ComicDirectorDecision | Omit<ComicDirectorApplyInput, "expectedRevision">,
  ) => {
    let result: ComicDirectorProposal | undefined;
    await run(async () => {
      const current = getDetail();
      const expectedRevision = proposal.input.action === "enhance"
        ? (proposal.appliedRevision ?? proposal.baseRevision)
        : proposal.baseRevision;
      if (!current || current.series.revision !== expectedRevision) {
        setNotice(t("剧集已更新，请基于最新修订生成提案"));
        if (current) load(await comicDramaApi.get(current.series.id));
        return;
      }
      try {
        result = await comicDirectorApi.apply(current.series.id, proposal.id, expectedRevision, decision);
      } catch (error) {
        if (error instanceof ApiClientError && (error.code === "DIRECTOR_PROPOSAL_STALE" || error.code === "REVISION_CONFLICT")) {
          load(await comicDramaApi.get(current.series.id));
        }
        throw error;
      }
      if (result.sequelId) saved(await comicDramaApi.get(result.sequelId));
      else load(await comicDramaApi.get(current.series.id));
    });
    return result;
  };
  const applyDirectorRole = async (proposal: ComicDirectorProposal, index: number, input: DirectorRoleChoiceInput) => {
    let outcome: ComicDirectorRoleOutcome | undefined;
    await run(async () => {
      const current = getDetail();
      if (!current) return;
      const targetId = proposal.sequelId ?? current.series.id;
      const targetDetail = targetId === current.series.id ? current : await comicDramaApi.get(targetId);
      outcome = await comicDirectorApi.role(current.series.id, proposal.id, index, { ...input, expectedRevision: targetDetail.series.revision });
      load(await comicDramaApi.get(current.series.id));
    });
    return outcome;
  };

  const activeNavSummary = series && !series.archivedAt
    ? (detail?.summary ?? {
      dramaId: series.dramaId, dramaTitle: detail?.drama?.title ?? series.seriesGroup ?? series.title,
      episodeNo: series.episodeNo ?? 1, episodeCount: detail?.episodes?.length ?? 1,
      seriesId: series.id, title: series.title, archived: false, clipCount: detail.clips.length,
      completedCount: detail.clips.filter(c => c.progress?.videoState === "ready").length, generatingCount: 0,
      totalDurationMs: detail.clips.reduce((s, c) => s + c.draft.durationMs, 0),
      estimatedMicros: null, estimatedUnverifiedCount: 0, spentMicros: 0, spentUnverifiedCount: 0, currency: "CNY" as const,
    })
    : sidebarSummary;

  const activeClip = detail ? (detail.clips.find(clip => clip.id === selected) ?? detail.clips[0] ?? null) : null;
  const episodeSummary = detail?.summary;
  const dramaTitle = detail?.drama?.title ?? series?.seriesGroup ?? series?.title ?? "";
  const episodeNo = series?.episodeNo ?? 1;
  const siblingEpisodes = detail?.episodes ?? [];
  const activeClipScene = activeClip ? (editor.clips[activeClip.id]?.draft.scene ?? activeClip.draft.scene) : "";
  const currentDramaPreset = series ? {
    id: series.dramaId,
    title: dramaTitle,
    styleKey: detail?.drama?.styleKey ?? series.styleKey,
    aspectRatio: detail?.drama?.aspectRatio ?? series.aspectRatio,
    videoModel: detail?.drama?.videoModel ?? series.videoModel,
    nextEpisodeNo: Math.max(0, ...siblingEpisodes.map(ep => ep.episodeNo), episodeNo) + 1,
    latestEpisodeId: siblingEpisodes.at(-1)?.id ?? series.id,
  } : undefined;
  const presetFromTree = (drama: ComicDramaTreeEntry): PresetDramaTarget => ({
    id: drama.id,
    title: drama.title,
    styleKey: drama.styleKey,
    aspectRatio: drama.aspectRatio,
    videoModel: drama.videoModel,
    nextEpisodeNo: Math.max(0, ...drama.episodes.map(ep => ep.episodeNo)) + 1,
    latestEpisodeId: drama.episodes.at(-1)?.id ?? null,
  });

  return <div className="comic-workspace">
    <aside className="comic-sidebar">
      <BrandHeader user={user} onLogout={() => void leave(onLogout)} onOpenAssistant={() => void leave(onOpenAssistant)}
        onOpenDigitalEmployee={() => void leave(onOpenDigitalEmployee)} onOpenComicDrama={() => void leave(() => navigate(COMIC_DRAMA_ROOT))}
        activeModule="comicDrama" />
      <nav className="comic-nav" aria-label={t("漫剧工厂")}>
        <button className="comic-nav-new primary" type="button" onClick={() => showDialog("create")}>
          <span className="comic-nav-new-icon" aria-hidden="true"><NewEpisodeIcon size={16} /></span>
          <span>{t("新建剧集")}</span>
        </button>

        <div className="comic-nav-group">
          <span className="comic-nav-section" aria-hidden="true">{t("创作工坊")}</span>
          <button
            type="button"
            className={`comic-nav-current${activeNavSummary ? " has-series" : ""}`}
            aria-current={workspace ? "page" : undefined}
            onClick={() => void leave(() => navigate(COMIC_DRAMA_ROOT))}
          >
            <span className="comic-nav-icon" data-tone="jade" aria-hidden="true"><ClapperboardIcon size={16} /></span>
            <span className="comic-nav-current-copy">
              <small className="comic-nav-drama-name">
                {activeNavSummary?.dramaTitle
                  ? `${t("整部剧集")} · ${activeNavSummary.dramaTitle}`
                  : t("当前剧集")}
              </small>
              <strong>
                {activeNavSummary
                  ? `${activeNavSummary.episodeNo ? `${t("第 {0} 集", [activeNavSummary.episodeNo])} · ` : ""}${activeNavSummary.title}`
                  : t("工作区")}
              </strong>
              {activeNavSummary && (
                <small className="comic-nav-progress">
                  {series && activeClip ? `${t("分镜 {0}/{1}", [activeClip.ordinal, detail.clips.length])} · ` : ""}
                  {t("已完成 {0}/{1}", [activeNavSummary.completedCount, activeNavSummary.clipCount])}
                  {activeNavSummary.generatingCount > 0 && <> · {t("生成中 {0}", [activeNavSummary.generatingCount])}</>}
                </small>
              )}
            </span>
          </button>
          {workspace && series && siblingEpisodes.length > 0 && (
            <div className="comic-nav-episodes" aria-label={t("本剧分集")}>
              {siblingEpisodes.map(ep => (
                <button
                  key={ep.id}
                  type="button"
                  className="comic-nav-ep-item"
                  aria-current={ep.id === series.id ? "true" : undefined}
                  onClick={() => void leave(() => {
                    if (ep.id !== series.id) {
                      warnGeneratingIfSwitching(ep.id);
                      navigate(seriesPath(ep.id));
                    }
                  })}
                >
                  <span className="comic-nav-ep-no">{t("第 {0} 集", [ep.episodeNo])}</span>
                  <span className="comic-nav-ep-title">{ep.title}</span>
                </button>
              ))}
              {!locked && currentDramaPreset && (
                <button type="button" className="comic-nav-ep-add" onClick={() => showDialog("addEpisode", currentDramaPreset)}>
                  ＋ {t("新增分集")}
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className="comic-nav-item"
            aria-current={history ? "page" : undefined}
            onClick={() => void leave(() => navigate(historyPath))}
          >
            <span className="comic-nav-icon" data-tone="jade" aria-hidden="true"><EpisodesIcon size={15} /></span>
            <span>{t("历史剧集")}</span>
          </button>
        </div>

        <div className="comic-nav-group">
          <span className="comic-nav-section" aria-hidden="true">{t("美术与资产")}</span>
          {libraryPaths.map(({ suffix, label, tone, Icon }) => (
            <button
              type="button"
              key={suffix}
              className="comic-nav-item"
              aria-current={library === suffix ? "page" : undefined}
              onClick={() => void leave(() => navigate(COMIC_DRAMA_ROOT + suffix))}
            >
              <span className="comic-nav-icon" data-tone={tone} aria-hidden="true"><Icon size={15} /></span>
              <span>{t(label)}</span>
            </button>
          ))}
        </div>

        <div className="comic-nav-group">
          <span className="comic-nav-section" aria-hidden="true">{t("成片与剪辑")}</span>
          <button
            type="button"
            className="comic-nav-item"
            aria-current={videoHistory ? "page" : undefined}
            onClick={() => void leave(() => navigate(videosPath))}
          >
            <span className="comic-nav-icon" data-tone="gold" aria-hidden="true"><VideoReelIcon size={15} /></span>
            <span>{t("历史成片")}</span>
          </button>
          <button
            type="button"
            className="comic-nav-item"
            aria-current={editorRoute && !renderHistory ? "page" : undefined}
            onClick={() => void leave(() => navigate(editorPath))}
          >
            <span className="comic-nav-icon" data-tone="coral" aria-hidden="true"><TimelineEditIcon size={15} /></span>
            <span>{t("剪辑工作台")}</span>
          </button>
          <button
            type="button"
            className="comic-nav-item"
            aria-current={renderHistory ? "page" : undefined}
            onClick={() => void leave(() => navigate(renderHistoryPath))}
          >
            <span className="comic-nav-icon" data-tone="slate" aria-hidden="true"><ExportBoxIcon size={15} /></span>
            <span>{t("导出历史")}</span>
          </button>
        </div>
      </nav>
    </aside>
    <main className="comic-page" aria-busy={loading || busy}>
      {bgNotice && (
        <div className="comic-generation-note comic-bg-notice" role="status">
          <span>{bgNotice}</span>
          <button type="button" onClick={() => setBgNotice(null)}>{t("知道了")}</button>
        </div>
      )}
      {notice && <div className="comic-error" role="alert">{notice} <button type="button" onClick={() => {
        loadedPath.current = "";
        load(null);
        setRetry(value => value + 1);
      }} disabled={dirty}>{t("重新读取")}</button></div>}
      {editor.issue && <div className="comic-error" role="alert">
        {t(editor.issue.kind === "conflict" ? "其他窗口已更新，未保存的编辑仍在本页" : "自动保存失败，未保存的编辑仍在本页")}
        {editor.issue.kind === "failed" ? <button type="button" onClick={() => void flush(true)}>{t("重试保存")}</button>
          : <button type="button" onClick={() => void checkLatest()}>{t("对比最新版本")}</button>}
        {latest && editor.issue.kind === "conflict" && <div className="comic-compare">
          <strong>{t("服务器版本")}</strong>
          <pre>{issueIsScript ? latest.script?.content || "—" : issueClip ? [
            issueClip.draft.scene, t("{0} 秒", [issueClip.draft.durationMs / 1000]), ...issueClip.draft.shots.map(shot => shot.description),
            ...issueClip.draft.lines.map(line => line.text),
          ].join("\n") : t("分镜已被删除")}</pre>
          <div className="comic-actions">
            <button type="button" onClick={() => { load(latest); setLatest(null); }}>{t("放弃本地改动并载入")}</button>
            <button type="button" disabled={!!latest.series.archivedAt || (!issueIsScript && !issueClip)}
              onClick={() => { reapply(latest); setLatest(null); }}>{t("使用本地改动重新保存")}</button>
          </div>
        </div>}
      </div>}
      {loading ? <p role="status">{t("加载中…")}</p> : loadError ?
        <div className="comic-empty"><p>{t("剧集暂时无法读取")}</p>
          <button type="button" onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></div>
        : history ? <SeriesHistory busy={busy} refreshToken={historyRefresh} focusDramaId={series?.dramaId ?? null}
          open={id => void leave(() => { warnGeneratingIfSwitching(id); navigate(seriesPath(id)); })}
          derive={(id, action, inherit) => run(async () => saved(await comicDramaApi.derive(id, action, inherit)))}
          change={async (entry, action) => {
            if (action === "remove" && !window.confirm(t(entry.clipCount > 0 ? "删除此剧集？已导出的正片不会删除。" : "删除此剧集？"))) return false;
            return run(async () => {
              await comicDramaApi[action](entry.id, entry.revision);
              if (getDetail()?.series.id === entry.id) load(null);
              if (sidebarSummary?.seriesId === entry.id) setSidebarSummary(null);
              setHistoryRefresh(v => v + 1);
            });
          }}
          onCreateDrama={() => showDramaDialog("create")}
          onEditDrama={drama => showDramaDialog("edit", drama)}
          onAddEpisode={drama => showDialog("addEpisode", presetFromTree(drama))}
          onDramaChange={async (drama, action) => {
            const msg = action === "remove"
              ? t("删除整部剧集？其下所有分集也将被删除，已导出的正片不会删除。")
              : t("归档整部剧集？其下所有分集也将一并归档。");
            if (!window.confirm(msg)) return false;
            return run(async () => {
              if (action === "archive") await comicDramaApi.archiveDrama(drama.id, drama.revision);
              else await comicDramaApi.removeDrama(drama.id, drama.revision);
              if (getDetail()?.series.dramaId === drama.id) load(null);
              if (sidebarSummary?.dramaId === drama.id) setSidebarSummary(null);
              setHistoryRefresh(v => v + 1);
            });
          }} />
        : library === "/characters" ? <CharacterLibrary characterId={characterId}
          open={id => navigate(COMIC_DRAMA_ROOT + "/characters" + (id ? "/" + id : ""))} />
        : library === "/materials" ? <MaterialLibrary />
        : library === "/settings" ? <ComicSettingsPage videoModels={models} imageModels={imageModels} />
        : renderHistory ? <ComicRenderPanel />
        : editId ? <ComicEditWorkspace key={editId} id={editId} setGuard={setEditGuard} openVideo={openVideo}
          autoOpenDialogue={pendingAutoDialogueEditId === editId}
          onAutoDialogueOpened={() => setPendingAutoDialogueEditId(null)}
          exit={() => void leave(() => navigate(editorPath))} />
        : editorRoute && takeId ? <ComicEditorSource key={takeId} takeId={takeId} open={openVideo} openEdit={openEdit}
          browse={() => navigate(editorSourcesPath)} />
        : videoHistory || pickingSource ? <ComicVideoHistory key={pathname} picker={pickingSource} open={openVideo} choose={choose} openEdit={openEdit} />
        : editorRoute ? <ComicEditsIndex currentSeries={activeNavSummary?.seriesId ?? series?.id}
          open={(nextId, opts) => {
            if (opts?.openAutoDialogue) setPendingAutoDialogueEditId(nextId);
            openEdit(nextId);
          }}
          browse={() => navigate(editorSourcesPath)} />
        : !series || !detail ? (
          <ComicStudioLanding
            onCreateSeries={() => showDialog("create")}
            onOpenHistory={() => void leave(() => navigate(historyPath))}
            onOpenCharacters={() => void leave(() => navigate(COMIC_DRAMA_ROOT + "/characters"))}
            onOpenMaterials={() => void leave(() => navigate(COMIC_DRAMA_ROOT + "/materials"))}
            onOpenEditor={() => void leave(() => navigate(editorPath))}
          />
        ) : <>
          <header className="comic-heading comic-episode-slate">
            <ComicWorkspaceHierarchyBar
              dramaTitle={dramaTitle}
              episodeCount={siblingEpisodes.length || 1}
              episodeId={series.id}
              episodeNo={episodeNo}
              episodeTitle={series.title}
              episodes={siblingEpisodes}
              activeClipOrdinal={activeClip?.ordinal ?? null}
              activeClipScene={activeClipScene}
              totalClips={detail.clips.length}
              locked={locked}
              onSelectEpisode={targetId => void leave(() => {
                warnGeneratingIfSwitching(targetId);
                navigate(seriesPath(targetId));
              })}
              onAddEpisode={() => { if (currentDramaPreset) showDialog("addEpisode", currentDramaPreset); }}
              onEditDrama={() => {
                if (detail.drama) showDramaDialog("edit", detail.drama);
                else showDialog("edit");
              }}
              onOpenDramaHistory={() => void leave(() => navigate(historyPath))}
              onFocusClip={activeClip ? () => editStoryboardClip(activeClip.id) : undefined}
            />
            <div className="comic-episode-meta">
              {editingTitle && !locked ? (
                <input
                  className="comic-inline-title-input"
                  aria-label={t("剧集名称")}
                  maxLength={120}
                  autoFocus
                  value={titleDraft}
                  onChange={e => setTitleDraft(e.target.value)}
                  onBlur={commitInlineTitle}
                  onKeyDown={e => {
                    if (e.key === "Enter") commitInlineTitle();
                    if (e.key === "Escape") setEditingTitle(false);
                  }}
                />
              ) : (
                <h1
                  className={!locked ? "comic-editable-title" : undefined}
                  title={!locked ? t("点击编辑标题") : undefined}
                  onClick={() => { if (!locked) { setTitleDraft(series.title); setEditingTitle(true); } }}
                >
                  {series.title}
                </h1>
              )}
              {series.logline && <p>{series.logline}</p>}
              {episodeSummary && (() => {
                const costs = episodeSummary.costs;
                return <div className="comic-episode-stats" aria-label={t("本集进度与费用")}>
                  <span>{t("{0} 个分镜", [episodeSummary.clipCount])}</span>
                  <span>{t("已完成 {0}/{1}", [episodeSummary.completedCount, episodeSummary.clipCount])}</span>
                  {episodeSummary.generatingCount > 0 && <span>{t("生成中 {0}", [episodeSummary.generatingCount])}</span>}
                  <span>{t("总时长 {0} 秒", [+(episodeSummary.totalDurationMs / 1000).toFixed(1)])}</span>
                  <span>
                    {costs.settled.length > 0
                      ? t("已花费 {0}", [formatCurrencyList(costs.settled)])
                      : t("已花费 暂无实扣")}
                  </span>
                  {costs.quotedUnbilled.length > 0 && (
                    <span>{t("未出账估算 {0}", [formatCurrencyList(costs.quotedUnbilled)])}</span>
                  )}
                  {(costs.pendingReconcileCount > 0 || (costs.unbilledReadyCount > 0 && costs.quotedUnbilled.length === 0)) && (
                    <span>{t("待核对 {0} 笔", [costs.pendingReconcileCount])}</span>
                  )}
                </div>;
              })()}
            </div>
            <div className="comic-actions">
              <span className="comic-ratio">
                {series.aspectRatio} · {styles.find(style => style.key === series.styleKey)?.labels[locale] ?? series.styleKey}
              </span>
              <small
                className="comic-save-pill"
                data-state={series.archivedAt ? "archived" : editor.issue ? "issue" : editor.saving || dirty ? "saving" : "saved"}
                role="status"
              >
                {t(series.archivedAt ? "已归档" : editor.saving || dirty && !editor.issue ? "保存中…" : editor.issue ? "未保存" : "已保存")}
              </small>
              {(() => {
                const kfPlan = computeComicBatchPlan(detail.clips, "keyframe");
                const vidPlan = computeComicBatchPlan(detail.clips, "from_keyframe");
                const kfLabel = kfPlan.allCompleted
                  ? t("首帧已完成")
                  : kfPlan.remainingCount > 0
                    ? t("生成首帧（{0} + 余 {1}）", [kfPlan.batchIds.length, kfPlan.remainingCount])
                    : kfPlan.batchIds.length > 0
                      ? t("生成首帧（{0}）", [kfPlan.batchIds.length])
                      : t("生成全部首帧");
                const vidLabel = vidPlan.allCompleted
                  ? t("视频已完成")
                  : vidPlan.remainingCount > 0
                    ? t("生成视频（{0} + 余 {1}）", [vidPlan.batchIds.length, vidPlan.remainingCount])
                    : vidPlan.batchIds.length > 0
                      ? t("生成视频（{0}）", [vidPlan.batchIds.length])
                      : t("生成全部视频");
                return <>
                  <button type="button" disabled={locked || !detail.clips.length} onClick={() => void leave(() => {
                    setOpenVideos(false); setStage("生成"); setQuickAction({ mode: "keyframe", token: Date.now() });
                  })}>{kfLabel}</button>
                  <button type="button" disabled={locked || !detail.clips.length} onClick={() => void leave(() => {
                    setOpenVideos(true); setStage("生成"); setQuickAction({ mode: "from_keyframe", token: Date.now() });
                  })}>{vidLabel}</button>
                </>;
              })()}
               <button type="button" onClick={() => void leave(() => navigate(editorPath))}>{t("去剪辑")}</button>
               <button type="button" onClick={() => void leave(() => setBudgetSeriesId(series.id))}>{t("整集费用预估")}</button>
              <button type="button" disabled={locked} onClick={() => showDialog("edit")}>{t("编辑剧集")}</button>
              <button type="button" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(v => !v)}>
                {t(drawerOpen ? "收起侧栏" : "展开助手")}
              </button>
            </div>
          </header>

          <ComicVideoCreditPauses key={series.id} seriesId={series.id} label={id => {
            const clip = detail.clips.find(clip => clip.id === id);
            return clip ? t("分镜 {0}", [clip.ordinal]) : t("视频");
          }} />
          {budgetSeriesId === series.id && <ComicEpisodeBudgetDialog detail={detail} close={() => setBudgetSeriesId(null)} />}

          <nav className="comic-steps comic-stage-dock" aria-label={t("制作步骤")}>
            {steps.map(({ key: step, Icon }, index) => {
              const stepBadge = step === "剧本" ? (detail.script ? `v${detail.script.version}` : null)
                : step === "选角" ? (detail.cast.length ? String(detail.cast.length) : null)
                  : step === "分镜" ? (detail.clips.length ? String(detail.clips.length) : null)
                    : step === "生成" && episodeSummary ? `${episodeSummary.completedCount}/${episodeSummary.clipCount}`
                      : null;
              return (
                <button
                  key={step}
                  type="button"
                  aria-pressed={stage === step}
                  onClick={() => {
                    if (step === "生成") void leave(() => { if (stage !== step) setOpenVideos(false); setStage(step); });
                    else if (step === "剪辑") void leave(() => navigate(editorPath));
                    else setStage(step);
                  }}
                >
                  <span className="comic-step-index">{index + 1}</span>
                  <span className="comic-step-icon" aria-hidden="true"><Icon size={14} /></span>
                  <span>{t(step)}</span>
                  {stepBadge && <small className="comic-step-badge">{stepBadge}</small>}
                </button>
              );
            })}
          </nav>

          {/* Persistent episode cast strip (v1 approved) */}
          <div className="comic-cast-strip" aria-label={t("本集角色")}>
            <strong className="comic-cast-strip-label">{t("本集选角")}</strong>
            {detail.cast.length === 0 ? <small>{t("尚未为本集选角")}</small> : (
              <div className="comic-cast-strip-chips">
                {detail.cast.map(entry => (
                  <button key={entry.snapshot.characterId} type="button" className="comic-cast-chip" onClick={() => setStage("选角")}>
                    <span>{entry.snapshot.name}</span>
                    <small>{entry.snapshot.outfitName}</small>
                    {entry.hasUpdates && <i className="comic-update-dot" title={t("角色库有更新")} />}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="comic-cast-strip-manage" onClick={() => setStage("选角")}>{t("管理选角")}</button>
          </div>

          <div className={`comic-workbench-body${drawerOpen ? "" : " drawer-collapsed"}`}>
            <div className="comic-workbench-main">
              {stage === "剧本" ? (() => {
                const scriptText = editor.script?.content ?? detail.script?.content ?? "";
                const hasSelection = !!scriptSelection
                  && scriptSelection.end > scriptSelection.start
                  && scriptSelection.end <= scriptText.length
                  && scriptText.slice(scriptSelection.start, scriptSelection.end).trim().length > 0;
                return (
                  <section className="comic-edit-card comic-script">
                    <label>{t("剧本正文")}<textarea aria-label={t("剧本正文")} rows={16} maxLength={20000} disabled={locked}
                      value={scriptText}
                      onChange={event => { setScriptSelection(null); editScript(event.target.value); }}
                      onSelect={event => {
                        const { selectionStart, selectionEnd } = event.currentTarget;
                        setScriptSelection(selectionEnd > selectionStart ? { start: selectionStart, end: selectionEnd } : null);
                      }} /></label>
                    <div className="comic-actions">
                      {detail.script && <small>{t("版本 {0}", [detail.script.version])}</small>}
                      <button
                        type="button"
                        disabled={locked || !scriptText.trim()}
                        onClick={() => void leave(() => {
                          setDrawerOpen(true);
                          setDrawerTab("director");
                          setEnhanceIntent({ token: Date.now(), target: { scope: "script_full" } });
                        })}
                      >
                        {t("AI 增强整篇剧本")}
                      </button>
                      <button
                        type="button"
                        disabled={locked || !scriptText.trim()}
                        onClick={() => void leave(() => {
                          setDrawerOpen(true);
                          setDrawerTab("director");
                          setEnhanceIntent({
                            token: Date.now(),
                            target: { scope: "script_excerpt", ...(hasSelection ? { ranges: [scriptSelection!] } : {}) },
                          });
                        })}
                      >
                        {t(hasSelection ? "AI 增强选中原文" : "AI 增强段落")}
                      </button>
                    </div>
                    <ScriptVersionViewer seriesId={series.id} currentVersion={detail.script?.version ?? 0} />
                  </section>
                );
              })() : stage === "选角" ? (
                <CastPanel key={series.id} seriesId={series.id} revision={series.revision} cast={detail.cast}
                  disabled={locked || !!editor.issue} change={change => changeContent((id, revision) => comicDramaApi.changeCast(id, revision, change))} />
              ) : stage === "生成" ? (
                <ComicImageGeneration key={series.id} detail={detail} selected={selected} select={setSelected}
                  choose={choose} editClip={editStoryboardClip} initialMode={openVideos ? "from_keyframe" : "keyframe"} quickAction={quickAction}
                  onQuickActionHandled={() => setQuickAction(null)} onSeriesChanged={() => void reloadCurrent()}
                  disabled={locked || !!editor.issue} getSaved={async () => await flush() ? getDetail() : null} />
              ) : (
                <Storyboard dramaTitle={dramaTitle} series={series} clips={detail.clips} cast={detail.cast} drafts={editor.clips}
                  locked={locked} disabled={locked || !!editor.issue} selected={selected} select={setSelected} edit={editClip}
                  add={afterClipId => changeContent(
                    (sid, revision) => comicDramaApi.addClip(sid, revision, afterClipId ? { afterClipId } : undefined),
                    result => setSelected(afterClipId
                      ? result.clips[result.clips.findIndex(c => c.id === afterClipId) + 1]?.id ?? null
                      : result.clips.at(-1)?.id ?? null),
                  )}
                  copy={id => changeContent((sid, revision) => comicDramaApi.copyClip(sid, id, revision))}
                  remove={id => {
                    if (window.confirm(t("删除此分镜？"))) changeContent((sid, revision) => comicDramaApi.removeClip(sid, id, revision));
                  }}
                  reorder={ids => changeContent((id, revision) => comicDramaApi.reorder(id, ids, revision))}
                  onEnhanceClip={clipId => void leave(() => {
                    setSelected(clipId);
                    setDrawerOpen(true);
                    setDrawerTab("director");
                    setEnhanceIntent({ token: Date.now(), target: { scope: "clips", clipIds: [clipId] } });
                  })} />
              )}
            </div>

            {drawerOpen && (
              <aside className="comic-right-drawer" aria-label={t("右侧辅助面板")}>
                <div className="comic-actions comic-drawer-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={drawerTab === "detail"} onClick={() => setDrawerTab("detail")}>
                    {t("成片详情")}
                  </button>
                  <button type="button" role="tab" aria-selected={drawerTab === "director"} onClick={() => setDrawerTab("director")}>
                    {t("导演助手")}
                  </button>
                </div>
                {drawerTab === "detail" ? (
                  <ClipInspectorDrawer
                    detail={detail}
                    clip={activeClip}
                    goStoryboard={editStoryboardClip}
                    goGenerate={(clipId, videoMode) => { setSelected(clipId); setOpenVideos(videoMode); setStage("生成"); }}
                  />
                ) : (
                  <ComicDirectorPanel key={series.id} detail={detail} locked={locked || !!editor.issue}
                    getSaved={async () => await flush() ? getDetail() : null} apply={applyProposal} applyRole={applyDirectorRole}
                    openClip={id => openVideo(series.id, id)} editClip={editStoryboardClip} onSeriesChanged={() => void reloadCurrent()}
                    selectedClipId={activeClip?.id ?? null} enhanceIntent={enhanceIntent}
                    onEnhanceIntentHandled={clearEnhanceIntent} />
                )}
              </aside>
            )}
          </div>
        </>}
    </main>
    {dialog && <SeriesDialog
      series={dialog === "edit" ? series : undefined}
      presetDrama={dialog === "addEpisode" ? presetDrama : undefined}
      models={models}
      error={modalError}
      close={() => { setDialog(null); setPresetDrama(undefined); }}
      save={saveDialog}
    />}
    {dramaDialog && <DramaDialog
      drama={dramaDialog.mode === "edit" ? dramaDialog.drama : undefined}
      models={models}
      error={modalError}
      close={() => setDramaDialog(null)}
      save={saveDramaDialog}
    />}
  </div>;
}

function ScriptVersionViewer({ seriesId, currentVersion }: { seriesId: string; currentVersion: number }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<ComicDramaScriptVersion[] | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void comicDramaApi.scriptHistory(seriesId, controller.signal).then(res => {
      if (!controller.signal.aborted) setVersions(res.versions);
    }).catch(() => { if (!controller.signal.aborted) setVersions([]); });
    return () => controller.abort();
  }, [open, seriesId, currentVersion]);
  return (
    <details className="comic-script-history" onToggle={e => setOpen(e.currentTarget.open)}>
      <summary>{t("查看剧本版本历史")}</summary>
      {versions === null ? <p role="status">{t("加载中…")}</p> : versions.length === 0 ? <small>{t("暂无历史版本")}</small> : (
        <ul className="comic-version-list">
          {versions.map(v => (
            <li key={v.version}>
              <strong>{t("版本 {0}", [v.version])}</strong>
              <small> · {t(v.source === "assistant" ? "导演提案" : "手动编辑")} · {new Date(v.createdAt).toLocaleString(locale)}</small>
              <pre>{v.content.slice(0, 600)}{v.content.length > 600 ? "…" : ""}</pre>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ClipInspectorDrawer({ detail, clip, goStoryboard, goGenerate }: {
  detail: ComicDramaDetail;
  clip: ComicDramaDetail["clips"][number] | null;
  goStoryboard: (id: string) => void;
  goGenerate: (id: string, videoMode: boolean) => void;
}) {
  const { t } = useI18n();
  if (!clip) return <section className="comic-edit-card"><p className="comic-generation-note">{t("请先添加或选择一个分镜查看详情")}</p></section>;
  const dramaTitle = detail.drama?.title ?? detail.series.seriesGroup ?? detail.series.title;
  const episodeNo = detail.series.episodeNo ?? 1;
  const issues = checkComicClipIssues(detail.series, clip, detail.cast);
  return (
    <section className="comic-edit-card comic-clip-inspector">
      <header>
        <div>
          <ComicClipOriginBadge
            dramaTitle={dramaTitle}
            episodeNo={episodeNo}
            episodeTitle={detail.series.title}
            clipOrdinal={clip.ordinal}
            totalClips={detail.clips.length}
          />
          <h2>{t("分镜 {0}", [clip.ordinal])}</h2>
        </div>
        <small>{t("{0} 秒", [+(clip.draft.durationMs / 1000).toFixed(1)])}</small>
      </header>
      <p><strong>{t("场景")}：</strong>{clip.draft.scene || t("未命名分镜")}</p>
      {clip.progress?.keyframeMediaId && (
        <MediaPreview openOriginal media={{ id: clip.progress.keyframeMediaId, hasThumbnail: true, durationMs: null }} title={t("首帧图片")} />
      )}
      <dl className="comic-character-profile">
        <dt>{t("所属整部剧集")}</dt>
        <dd>{dramaTitle}</dd>
        <dt>{t("所属分集")}</dt>
        <dd>{t("第 {0} 集", [episodeNo])} · {detail.series.title}</dd>
        <dt>{t("首帧状态")}</dt>
        <dd>{t(clip.progress?.keyframeApproved ? "已确认首帧" : clip.progress?.keyframeState === "ready" ? "待确认首帧" : "未确认")}</dd>
        <dt>{t("当前采用版")}</dt>
        <dd>{clip.progress?.adoptedVideoVersion != null ? t("版本 {0}", [clip.progress.adoptedVideoVersion]) : t("未采用")}</dd>
        <dt>{t("视频版本数")}</dt>
        <dd>{clip.progress?.videoTakeCount ?? 0}</dd>
        <dt>{t("出镜人物")}</dt>
        <dd>{(clip.draft.cast ?? [])
          .map(a => detail.cast.find(c => c.snapshot.characterId === a.characterId)?.snapshot.name)
          .filter(Boolean).join(" / ") || "—"}</dd>
      </dl>
      {issues.length > 0 && (
        <div className="comic-issue-banner">
          <strong>{t("{0} 项查漏提醒", [issues.length])}</strong>
          <ul>{issues.map((issue, idx) => (
            <li key={idx}>
              {issue.code === "SPEAKER_NOT_IN_CAST" ? t("说话人「{0}」未在出镜人物中", [issue.speaker])
                : issue.code === "REFERENCE_LIMIT_EXCEEDED" ? t("参考图 {0}/{1} 张超限", [issue.count, issue.limit])
                  : issue.code === "DIALOGUE_TOO_LONG" ? t("台词约 {0} 秒超出镜头时长", [+(issue.estimatedMs / 1000).toFixed(1)])
                    : issue.code === "INVALID_MATERIAL_REFERENCE"
                      ? t("绑定的素材「{0}」已失效", [issue.name ?? issue.materialId.slice(0, 8)])
                      : t("角色「{0}」造型已更新", [issue.characterName])}
            </li>
          ))}</ul>
        </div>
      )}
      <div className="comic-actions">
        <button type="button" onClick={() => goStoryboard(clip.id)}>{t("编辑分镜")}</button>
        <button type="button" onClick={() => goGenerate(clip.id, false)}>{t("首帧审核")}</button>
        <button type="button" className="primary" onClick={() => goGenerate(clip.id, true)}>{t("生成视频")}</button>
      </div>
    </section>
  );
}
