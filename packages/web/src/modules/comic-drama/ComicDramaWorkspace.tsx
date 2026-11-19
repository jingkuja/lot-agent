import { useCallback, useEffect, useRef, useState } from "react";
import { COMIC_DRAMA_ROOT, type ComicDirectorDecision, type ComicDirectorProposal, type ComicDirectorRoleOutcome, type ComicDramaContent,
  type ComicDramaDetail, type ComicDramaSeriesInput } from "@lot-agent/core/comic-drama";
import { ApiClientError, type User } from "../../api/client.js";
import { BrandHeader } from "../../components/BrandHeader.js";
import { useI18n } from "../../i18n/index.js";
import { comicDramaApi } from "./api.js";
import { SeriesDialog, type ComicDramaModel } from "./SeriesDialog.js";
import { SeriesHistory } from "./SeriesHistory.js";
import { CastPanel } from "./CastPanel.js";
import { useComicChoices } from "./LibraryParts.js";
import { CharacterLibrary } from "./CharacterLibrary.js";
import { MaterialLibrary } from "./MaterialLibrary.js";
import { DictionarySettings } from "./DictionarySettings.js";
import { Storyboard } from "./Storyboard.js";
import { ComicImageGeneration } from "./ComicImageGeneration.js";
import { ComicVideoHistory } from "./ComicVideoHistory.js";
import { ComicEditorSource } from "./ComicEditorSource.js";
import { ComicEditsIndex } from "./ComicEditList.js";
import { ComicEditWorkspace } from "./ComicEditWorkspace.js";
import { ComicBreakdownSample } from "./ComicBreakdownSample.js";
import { ComicDirectorPanel } from "./ComicDirectorPanel.js";
import type { DirectorRoleChoiceInput } from "./DirectorConfirmations.js";
import { ComicRenderPanel } from "./ComicRenderPanel.js";
import { ComicStudioLanding } from "./ComicStudioLanding.js";
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
const renderHistoryPath = editorPath + "/exports";
const projectPrefix = editorPath + "/projects/";

export function ComicDramaWorkspace({ user, pathname, active, navigate, replacePath, onOpenAssistant, onOpenDigitalEmployee, onLogout, models }: Props) {
  const { t, locale } = useI18n();
  const styles = useComicChoices("style");
  const { editor, load, flush, editClip, editScript, reapply, dirty, getDetail } = useComicDramaDraft();
  const detail = editor.detail;
  const series = detail?.series;
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [stage, setStage] = useState<"剧本" | "选角" | "分镜" | "生成">("分镜");
  const [openVideos, setOpenVideos] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [latest, setLatest] = useState<ComicDramaDetail | null>(null);
  const routeQueue = useRef<Promise<void>>(Promise.resolve());
  const loadedPath = useRef(COMIC_DRAMA_ROOT);
  const history = pathname === historyPath;
  const videoHistory = pathname === videosPath;
  const editId = pathname.startsWith(projectPrefix) ? pathname.slice(projectPrefix.length) : "";
  const pickingSource = pathname === editorSourcesPath;
  const renderHistory = pathname === renderHistoryPath;
  const takeId = !editId && !pickingSource && !renderHistory && pathname.startsWith(editorPath + "/") ? pathname.slice(editorPath.length + 1) : "";
  const editorRoute = pathname === editorPath || pathname.startsWith(editorPath + "/");
  const editGuard = useRef<(() => boolean) | null>(null);
  const setEditGuard = useCallback((guard: (() => boolean) | null) => { editGuard.current = guard; }, []);
  const directId = pathname.startsWith(historyPath + "/") ? pathname.slice(historyPath.length + 1) : null;
  const library = libraryPaths.find(({ suffix }) => pathname === COMIC_DRAMA_ROOT + suffix ||
    (suffix === "/characters" && pathname.startsWith(COMIC_DRAMA_ROOT + suffix + "/")))?.suffix;
  const characterId = library === "/characters" ? pathname.split("/")[3] : undefined;
  const workspace = !history && !editorRoute && !library && !videoHistory;
  const locked = !!series?.archivedAt || busy;

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
      }
    }).catch(() => { if (live) setLoadError(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [active, directId, flush, getDetail, load, pathname, replacePath, retry, workspace]);

  const leave = async (callback: () => void) => {
    if (!busyRef.current && (editGuard.current?.() ?? true) && await flush()) callback();
  };
  const handleError = (error: unknown) => {
    if (error instanceof ApiClientError && error.code === "MODEL_UNAVAILABLE") return t("视频模型不可用，请重新选择");
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
    load(result);
    loadedPath.current = seriesPath(result.series.id);
    navigate(loadedPath.current);
  };
  const changeContent = (apply: (id: string, revision: number) => Promise<ComicDramaContent>, then?: (result: ComicDramaContent) => void) =>
    run(async () => {
      const current = getDetail();
      if (!current) return;
      const result = await apply(current.series.id, current.series.revision);
      load({ series: { ...current.series, revision: result.seriesRevision }, script: result.script, clips: result.clips, cast: result.cast });
      then?.(result);
    });
  const showDialog = (next: "create" | "edit") => void leave(() => { setModalError(null); setDialog(next); });
  const saveDialog = (fields: ComicDramaSeriesInput) => run(async () => {
    const current = getDetail();
    if (dialog === "edit" && current) {
      const updated = await comicDramaApi.update(current.series.id, fields, current.series.revision);
      load({ ...current, series: updated });
    } else saved(await comicDramaApi.create(fields));
  }, setModalError);

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
  const choose = (id: string) => void leave(() => navigate(editorPath + "/" + id));
  const openEdit = (id: string) => navigate(projectPrefix + id);
  const applyProposal = async (proposal: ComicDirectorProposal, decision?: ComicDirectorDecision) => {
    let result: ComicDirectorProposal | undefined;
    await run(async () => {
      const current = getDetail();
      if (!current || current.series.revision !== proposal.baseRevision) {
        setNotice(t("剧集已更新，请基于最新修订生成提案"));
        return;
      }
      result = await comicDirectorApi.apply(current.series.id, proposal.id, proposal.baseRevision, decision);
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
      outcome = await comicDirectorApi.role(current.series.id, proposal.id, index, { ...input, expectedRevision: current.series.revision });
      load(await comicDramaApi.get(current.series.id));
    });
    return outcome;
  };
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
            className={`comic-nav-current${series && !series.archivedAt ? " has-series" : ""}`}
            aria-current={workspace ? "page" : undefined}
            onClick={() => void leave(() => navigate(COMIC_DRAMA_ROOT))}
          >
            <span className="comic-nav-icon" data-tone="jade" aria-hidden="true"><ClapperboardIcon size={16} /></span>
            <span className="comic-nav-current-copy">
              <small>{t("当前剧集")}</small>
              <strong>{series && !series.archivedAt ? series.title : t("工作区")}</strong>
            </span>
          </button>
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
            issueClip.draft.scene, issueClip.draft.durationMs / 1000 + " s", ...issueClip.draft.shots.map(shot => shot.description),
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
        : history ? <SeriesHistory busy={busy} open={id => void leave(() => navigate(seriesPath(id)))}
          derive={(id, action, inherit) => run(async () => saved(await comicDramaApi.derive(id, action, inherit)))}
          change={async (entry, action) => {
            if (action === "remove" && !window.confirm(t("删除此剧集？"))) return false;
            return run(async () => {
              await comicDramaApi[action](entry.id, entry.revision);
              if (getDetail()?.series.id === entry.id) load(null);
            });
          }} />
        : library === "/characters" ? <CharacterLibrary characterId={characterId}
          open={id => navigate(COMIC_DRAMA_ROOT + "/characters" + (id ? "/" + id : ""))} />
        : library === "/materials" ? <MaterialLibrary />
        : library === "/settings" ? <DictionarySettings />
        : renderHistory ? <ComicRenderPanel />
        : editId ? <ComicEditWorkspace key={editId} id={editId} setGuard={setEditGuard} openVideo={openVideo}
          exit={() => void leave(() => navigate(editorPath))} />
        : editorRoute && takeId ? <ComicEditorSource key={takeId} takeId={takeId} open={openVideo} openEdit={openEdit}
          browse={() => navigate(editorSourcesPath)} />
        : videoHistory || pickingSource ? <ComicVideoHistory key={pathname} picker={pickingSource} open={openVideo} choose={choose} />
        : editorRoute ? <ComicEditsIndex currentSeries={series?.id} open={openEdit} browse={() => navigate(editorSourcesPath)} />
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
            <div className="comic-episode-meta">
              {series.seriesGroup && (
                <small className="comic-episode-series">
                  {series.seriesGroup}{series.episodeNo ? " / " + series.episodeNo : ""}
                </small>
              )}
              <h1>{series.title}</h1>
              {series.logline && <p>{series.logline}</p>}
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
              <button type="button" disabled={locked} onClick={() => showDialog("edit")}>{t("编辑剧集")}</button>
            </div>
          </header>
          <nav className="comic-steps comic-stage-dock" aria-label={t("制作步骤")}>
            {steps.map(({ key: step, Icon }, index) => (
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
                {t(step)}
              </button>
            ))}
          </nav>
          {stage === "剧本" ? <div className="comic-script-layout">
            <section className="comic-edit-card comic-script">
              <label>{t("剧本正文")}<textarea aria-label={t("剧本正文")} rows={16} maxLength={20000} disabled={locked}
                value={editor.script?.content ?? detail.script?.content ?? ""} onChange={event => editScript(event.target.value)} /></label>
              {detail.script && <small>{t("版本 {0}", [detail.script.version])}</small>}
              <ComicBreakdownSample />
            </section>
            <ComicDirectorPanel key={series.id} detail={detail} locked={locked || !!editor.issue}
              getSaved={async () => await flush() ? getDetail() : null} apply={applyProposal} applyRole={applyDirectorRole}
              openClip={id => openVideo(series.id, id)} />
          </div> : stage === "选角" ? <CastPanel key={series.id} seriesId={series.id} revision={series.revision} cast={detail.cast}
            disabled={locked || !!editor.issue} change={change => changeContent((id, revision) => comicDramaApi.changeCast(id, revision, change))} />
          : stage === "生成" ? <ComicImageGeneration key={series.id} detail={detail} selected={selected} select={setSelected}
            choose={choose} initialMode={openVideos ? "from_keyframe" : "keyframe"} disabled={locked || !!editor.issue}
            getSaved={async () => await flush() ? getDetail() : null} />
          : <Storyboard clips={detail.clips} cast={detail.cast} drafts={editor.clips} locked={locked} disabled={locked || !!editor.issue}
            selected={selected} select={setSelected} edit={editClip}
            add={() => changeContent(comicDramaApi.addClip, result => setSelected(result.clips.at(-1)?.id ?? null))}
            copy={id => changeContent((sid, revision) => comicDramaApi.copyClip(sid, id, revision))}
            remove={id => {
              if (window.confirm(t("删除此分镜？"))) changeContent((sid, revision) => comicDramaApi.removeClip(sid, id, revision));
            }}
            reorder={ids => changeContent((id, revision) => comicDramaApi.reorder(id, ids, revision))} />}
        </>}
    </main>
    {dialog && <SeriesDialog series={dialog === "edit" ? series : undefined} models={models}
      error={modalError} close={() => setDialog(null)} save={saveDialog} />}
  </div>;
}
