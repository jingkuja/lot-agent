import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMIC_DRAMA_OUTLINE_MAX_CHARS, COMIC_DRAMA_SCRIPT_MAX_CHARS, COMIC_SCRIPT_FILE_BYTES, comicVideoModel,
  type ComicCastChange, type ComicDrama, type ComicDramaEpisodeBrief, type ComicDramaSeriesStatus, type ComicDramaView,
} from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { comicDramaApi } from "./api.js";
import { CastPanel } from "./CastPanel.js";
import {
  ArrowRightIcon, CharactersIcon, EpisodesIcon, NewEpisodeIcon, ScriptIcon, StoryboardIcon,
} from "./ComicStudioIcons.js";
import { comicDirectorError } from "./director-api.js";
import { LibraryDialog, MediaPreview, useComicChoices } from "./LibraryParts.js";

export type DramaHubTab = "outline" | "cast" | "script" | "episodes";

const statusLabels: Record<ComicDramaSeriesStatus, string> = {
  draft: "草稿",
  in_progress: "制作中",
  exported: "已导出",
};

type SaveIssue = { kind: "conflict" | "failed"; field: "outline" | "script" };

export function DramaHub({
  view, busy, initialTab, onUpdated, onReload, onEditDrama, onAddEpisode, onOpenEpisode, onDeriveEpisode,
  onChangeEpisode, onOpenHistory, onOpenCharacters, onRegisterFlush,
}: {
  view: ComicDramaView;
  busy: boolean;
  initialTab?: DramaHubTab;
  onUpdated: (next: ComicDramaView) => void;
  onReload: () => Promise<void>;
  onEditDrama: (drama: ComicDrama) => void;
  onAddEpisode: () => void;
  onOpenEpisode: (episodeId: string) => void;
  onDeriveEpisode: (episodeId: string, action: "copy" | "sequel", inherit?: boolean) => Promise<boolean>;
  onChangeEpisode: (episode: ComicDramaEpisodeBrief, action: "archive" | "remove") => Promise<boolean>;
  onOpenHistory: () => void;
  onOpenCharacters: () => void;
  onRegisterFlush?: (flush: (() => Promise<boolean>) | null) => void;
}) {
  const { t, locale } = useI18n();
  const styles = useComicChoices("style");
  const { drama, episodes, cast } = view;
  const locked = !!drama.archivedAt || busy;
  const [tab, setTab] = useState<DramaHubTab>(initialTab ?? "outline");
  const [outlineDraft, setOutlineDraft] = useState<string | null>(null);
  const [scriptDraft, setScriptDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState<SaveIssue | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [sequel, setSequel] = useState<ComicDramaEpisodeBrief | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const outlineRef = useRef(outlineDraft);
  outlineRef.current = outlineDraft;
  const scriptRef = useRef(scriptDraft);
  scriptRef.current = scriptDraft;
  const issueRef = useRef(issue);
  issueRef.current = issue;
  const inFlight = useRef<Promise<boolean> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dirty = outlineDraft !== null || scriptDraft !== null;
  const outlineValue = outlineDraft ?? drama.outline ?? "";
  const scriptValue = scriptDraft ?? drama.scriptContent ?? "";

  useEffect(() => {
    setOutlineDraft(null);
    setScriptDraft(null);
    setIssue(null);
    setImportNote(null);
    setImportError(null);
    setTab(initialTab ?? "outline");
  }, [drama.id, initialTab]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (outlineRef.current !== null || scriptRef.current !== null) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const flush = useCallback((retry = false): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    if (outlineRef.current === null && scriptRef.current === null) return Promise.resolve(true);
    if (issueRef.current && (!retry || issueRef.current.kind === "conflict")) return Promise.resolve(false);
    setSaving(true);
    setIssue(null);
    const runSave = async () => {
      let currentField: "outline" | "script" = "outline";
      try {
        while (outlineRef.current !== null || scriptRef.current !== null) {
          const cur = viewRef.current;
          if (outlineRef.current !== null) {
            currentField = "outline";
            const pending = outlineRef.current;
            const saved = await comicDramaApi.saveDramaOutline(cur.drama.id, pending, cur.drama.revision);
            const nextView: ComicDramaView = { ...viewRef.current, drama: saved };
            viewRef.current = nextView;
            onUpdated(nextView);
            if (outlineRef.current === pending) {
              outlineRef.current = null;
              setOutlineDraft(null);
            }
          } else if (scriptRef.current !== null) {
            currentField = "script";
            const pending = scriptRef.current;
            const saved = await comicDramaApi.saveDramaScript(cur.drama.id, pending, cur.drama.revision);
            const nextView: ComicDramaView = { ...viewRef.current, drama: saved };
            viewRef.current = nextView;
            onUpdated(nextView);
            if (scriptRef.current === pending) {
              scriptRef.current = null;
              setScriptDraft(null);
            }
          }
        }
        return true;
      } catch (error) {
        const conflict = error instanceof ApiClientError && (error.status === 409 || error.status === 404);
        const nextIssue: SaveIssue = { kind: conflict ? "conflict" : "failed", field: currentField };
        issueRef.current = nextIssue;
        setIssue(nextIssue);
        return false;
      } finally {
        setSaving(false);
        inFlight.current = null;
      }
    };
    inFlight.current = runSave();
    return inFlight.current;
  }, [onUpdated]);

  useEffect(() => {
    onRegisterFlush?.(() => flush());
    return () => onRegisterFlush?.(null);
  }, [flush, onRegisterFlush]);

  useEffect(() => {
    if (!dirty || issue || saving) return;
    const timer = window.setTimeout(() => void flush(), 650);
    return () => window.clearTimeout(timer);
  }, [dirty, flush, issue, outlineDraft, saving, scriptDraft]);

  const changeDramaCast = async (change: ComicCastChange): Promise<boolean> => {
    if (!await flush()) return false;
    try {
      const cur = viewRef.current;
      const result = await comicDramaApi.changeDramaCast(cur.drama.id, cur.drama.revision, change);
      const nextView: ComicDramaView = {
        ...viewRef.current,
        drama: { ...viewRef.current.drama, revision: result.dramaRevision },
        cast: result.cast,
      };
      viewRef.current = nextView;
      onUpdated(nextView);
      return true;
    } catch {
      return false;
    }
  };

  const handleImportFile = async (file: File) => {
    setImportError(null);
    setImportNote(null);
    if (!/\.(txt|docx)$/i.test(file.name)) {
      setImportError(t("请选择 TXT 或 DOCX 剧本文件"));
      return;
    }
    if (file.size > COMIC_SCRIPT_FILE_BYTES) {
      setImportError(t("剧本文件最大为 2 MB"));
      return;
    }
    setImporting(true);
    try {
      const result = await comicDramaApi.importDramaScript(drama.id, file);
      setScriptDraft(result.text);
      setImportNote(t(result.truncated ? "已截取前 50,000 个字符，请检查内容" : "文件正文已载入并自动保存"));
    } catch (error) {
      setImportError(t(comicDirectorError(error)));
    } finally {
      setImporting(false);
    }
  };

  const nextEpisodeNo = Math.max(0, ...episodes.map(ep => ep.episodeNo)) + 1;
  const hasOutline = outlineValue.trim().length > 0;
  const hasScript = scriptValue.trim().length > 0;
  const styleLabel = styles.find(item => item.key === drama.styleKey)?.labels[locale] ?? drama.styleKey;
  const videoLabel = comicVideoModel(drama.videoModel)?.label ?? drama.videoModel;
  const dramaSteps = [
    { key: "outline" as const, label: "大纲", Icon: ScriptIcon, badge: hasOutline ? t("已填") : t("待填"), ready: hasOutline },
    { key: "cast" as const, label: "角色", Icon: CharactersIcon, badge: cast.length ? String(cast.length) : t("待选"), ready: cast.length > 0 },
    { key: "script" as const, label: "剧本", Icon: StoryboardIcon, badge: hasScript ? t("已填") : t("待填"), ready: hasScript },
    { key: "episodes" as const, label: "分集", Icon: EpisodesIcon, badge: t("{0} 集", [episodes.length]), ready: episodes.length > 0 },
  ];

  return (
    <div className="comic-drama-hub">
      <header className="comic-heading comic-episode-slate comic-drama-hub-head">
        <div className="comic-drama-hub-title">
          <div className="comic-cut-badges">
            <span className="comic-hierarchy-level">{t("整部剧集")}</span>
            <span className="comic-ratio">
              {drama.aspectRatio} · {styleLabel}{videoLabel ? ` · ${videoLabel}` : ""}
            </span>
            <small
              className="comic-save-pill"
              data-state={drama.archivedAt ? "archived" : issue ? "issue" : saving || dirty ? "saving" : "saved"}
              role="status"
            >
              {t(drama.archivedAt ? "已归档" : saving || (dirty && !issue) ? "保存中…" : issue ? "未保存" : "已保存")}
            </small>
          </div>
          <h1>《{drama.title}》</h1>
          {drama.synopsis && <p>{drama.synopsis}</p>}
        </div>
        <div className="comic-actions">
          {!locked && (
            <button type="button" className="primary" onClick={onAddEpisode}>
              <NewEpisodeIcon size={15} />
              <span>{episodes.length === 0 ? t("创建第 1 集") : t("新增第 {0} 集", [nextEpisodeNo])}</span>
            </button>
          )}
          {!locked && (
            <button type="button" onClick={() => onEditDrama(drama)}>{t("编辑剧目设置")}</button>
          )}
          <button type="button" onClick={onOpenHistory}>{t("剧集总览")}</button>
        </div>
      </header>

      {issue && (
        <div className="comic-error" role="alert">
          {t(issue.kind === "conflict" ? "其他窗口已更新，未保存的编辑仍在本页" : "自动保存失败，未保存的编辑仍在本页")}
          {issue.kind === "failed" ? (
            <button type="button" onClick={() => void flush(true)}>{t("重试保存")}</button>
          ) : (
            <button type="button" onClick={() => {
              setOutlineDraft(null);
              setScriptDraft(null);
              setIssue(null);
              void onReload();
            }}>{t("放弃本地改动并载入")}</button>
          )}
        </div>
      )}

      <nav className="comic-steps comic-stage-dock" aria-label={t("全剧筹备步骤")}>
        {dramaSteps.map(({ key, label, Icon, badge, ready }, index) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            <span className="comic-step-index">{index + 1}</span>
            <span className="comic-step-icon" aria-hidden="true"><Icon size={14} /></span>
            <span>{t(label)}</span>
            <small className="comic-step-badge" data-ready={ready ? "true" : undefined}>{badge}</small>
          </button>
        ))}
      </nav>

      {tab === "outline" && (
        <section className="comic-edit-card comic-drama-editor">
          <header>
            <div>
              <h2>{t("全剧大纲")}</h2>
              <small>{t("先明确整部戏的世界观、主线冲突、核心人物弧光和分集规划。")}</small>
            </div>
            <small>{outlineValue.length} / {COMIC_DRAMA_OUTLINE_MAX_CHARS}</small>
          </header>
          <label className="comic-sr-label">
            <span>{t("全剧大纲")}</span>
            <textarea
              aria-label={t("全剧大纲")}
              rows={14}
              maxLength={COMIC_DRAMA_OUTLINE_MAX_CHARS}
              disabled={locked}
              value={outlineValue}
              placeholder={t("写下整部戏的故事主线、世界观设定、核心冲突，以及第 1 集到结局的节奏规划…")}
              onChange={event => setOutlineDraft(event.target.value)}
            />
          </label>
          <div className="comic-actions comic-drama-step-footer">
            <button type="button" className="primary" onClick={() => setTab("cast")}>
              <span>{t("下一步：设定全剧角色")}</span>
              <ArrowRightIcon size={14} />
            </button>
          </div>
        </section>
      )}

      {tab === "cast" && (
        <section className="comic-edit-card comic-drama-cast-section">
          <CastPanel
            key={drama.id}
            scope="drama"
            seriesId={drama.id}
            revision={drama.revision}
            cast={cast}
            disabled={locked || !!issue}
            change={changeDramaCast}
            onOpenLibrary={onOpenCharacters}
          />
          <div className="comic-actions comic-drama-step-footer">
            <button type="button" onClick={() => setTab("outline")}>{t("上一步：大纲")}</button>
            <button type="button" className="primary" onClick={() => setTab("script")}>
              <span>{t("下一步：编写全剧剧本")}</span>
              <ArrowRightIcon size={14} />
            </button>
          </div>
        </section>
      )}

      {tab === "script" && (
        <section className="comic-edit-card comic-drama-editor">
          <header>
            <div>
              <h2>{t("全剧剧本")}</h2>
              <small>{t("编写或导入整部剧的总剧本，可按「第 1 集」「第 2 集」分段，方便后续拆分集与分镜。")}</small>
            </div>
            <div className="comic-actions">
              <small>{scriptValue.length} / {COMIC_DRAMA_SCRIPT_MAX_CHARS}</small>
              {!locked && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.docx,text/plain"
                    className="comic-hidden-file"
                    onChange={event => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void handleImportFile(file);
                    }}
                  />
                  <button type="button" disabled={importing} onClick={() => fileInputRef.current?.click()}>
                    {t(importing ? "导入中…" : "导入 TXT / DOCX")}
                  </button>
                </>
              )}
            </div>
          </header>
          {importNote && <small className="comic-generation-note" role="status">{importNote}</small>}
          {importError && <p className="comic-error" role="alert">{importError}</p>}
          <label className="comic-sr-label">
            <span>{t("全剧剧本")}</span>
            <textarea
              aria-label={t("全剧剧本")}
              rows={18}
              maxLength={COMIC_DRAMA_SCRIPT_MAX_CHARS}
              disabled={locked}
              value={scriptValue}
              placeholder={t("例如：\n【第 1 集：雨夜风铃】\n场景：深夜便利店……")}
              onChange={event => setScriptDraft(event.target.value)}
            />
          </label>
          <div className="comic-actions comic-drama-step-footer">
            <button type="button" onClick={() => setTab("cast")}>{t("上一步：角色")}</button>
            <button type="button" className="primary" onClick={() => setTab("episodes")}>
              <span>{t("下一步：创建分集")}</span>
              <ArrowRightIcon size={14} />
            </button>
          </div>
        </section>
      )}

      {tab === "episodes" && (
        <section className="comic-drama-episodes-stage">
          <div className="comic-prep-checklist" aria-label={t("全剧筹备进度")}>
            <button type="button" className="comic-prep-chip" data-ready={hasOutline ? "true" : undefined} onClick={() => setTab("outline")}>
              <strong>{t("大纲")}</strong>
              <small>{hasOutline ? t("已填 {0} 字", [outlineValue.trim().length]) : t("未填写 · 去完善")}</small>
            </button>
            <button type="button" className="comic-prep-chip" data-ready={cast.length > 0 ? "true" : undefined} onClick={() => setTab("cast")}>
              <strong>{t("全剧角色")}</strong>
              <small>{cast.length > 0 ? t("已选 {0} 名", [cast.length]) : t("未设定 · 去选角")}</small>
            </button>
            <button type="button" className="comic-prep-chip" data-ready={hasScript ? "true" : undefined} onClick={() => setTab("script")}>
              <strong>{t("全剧剧本")}</strong>
              <small>{hasScript ? t("已填 {0} 字", [scriptValue.trim().length]) : t("未填写 · 去编写")}</small>
            </button>
          </div>

          {episodes.length === 0 ? (
            <div className="comic-empty comic-drama-empty-episodes">
              <h2>{t("从第 1 集开始创建分集")}</h2>
              <p>
                {t("大纲、角色和剧本准备就绪后，创建第 1 集并进入分集工作台编排多分镜；已设定的全剧角色和画风会自动带入。")}
              </p>
              {!locked && (
                <button type="button" className="primary" onClick={onAddEpisode}>
                  <NewEpisodeIcon size={16} />
                  <span>{t("创建第 1 集")}</span>
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="comic-section-heading">
                <h2>{t("分集列表（共 {0} 集）", [episodes.length])}</h2>
                {!locked && (
                  <button type="button" className="primary" onClick={onAddEpisode}>
                    ＋ {t("新增第 {0} 集", [nextEpisodeNo])}
                  </button>
                )}
              </div>
              <div className="comic-library-grid comic-series-grid">
                {episodes.map(entry => (
                  <article className="comic-library-card comic-series-card" key={entry.id}>
                    {entry.coverMediaId ? (
                      <MediaPreview media={{ id: entry.coverMediaId, hasThumbnail: true, durationMs: null }} title={entry.title} thumbOnly />
                    ) : (
                      <div className="comic-media-well comic-character-initial" aria-hidden="true">
                        {entry.episodeNo}
                      </div>
                    )}
                    <div className="comic-cut-badges">
                      <small className="comic-pill" data-tone="frame">{t("第 {0} 集", [entry.episodeNo])}</small>
                      <small className="comic-pill" data-tone={entry.status === "exported" ? "done" : entry.status === "in_progress" ? "busy" : "idle"}>
                        {t(statusLabels[entry.status])}
                      </small>
                    </div>
                    <button type="button" className="comic-history-title" onClick={() => onOpenEpisode(entry.id)} disabled={busy}>
                      <strong>{entry.title}</strong>
                      {entry.logline && <span className="comic-episode-card-logline">{entry.logline}</span>}
                      <small>
                        {t("{0} 个分镜", [entry.clipCount])}
                        {" · "}{t("已完成 {0}/{1}", [entry.completedCount, entry.clipCount])}
                        {entry.generatingCount > 0 ? <> · {t("生成中 {0}", [entry.generatingCount])}</> : null}
                        {" · "}{new Date(entry.updatedAt).toLocaleDateString(locale)}
                      </small>
                    </button>
                    <div className="comic-actions">
                      <button type="button" className="primary" disabled={busy} onClick={() => onOpenEpisode(entry.id)}>
                        {t("进入分镜")}
                      </button>
                      {!entry.archivedAt && (
                        <>
                          <button type="button" disabled={busy} onClick={() => void onDeriveEpisode(entry.id, "copy")}>{t("复制剧集")}</button>
                          <button type="button" disabled={busy} onClick={() => setSequel(entry)}>{t("续写下一集")}</button>
                          <button type="button" disabled={busy} onClick={() => void onChangeEpisode(entry, "archive")}>{t("归档")}</button>
                        </>
                      )}
                      <button type="button" disabled={busy} onClick={() => void onChangeEpisode(entry, "remove")}>{t("删除")}</button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {sequel && (
        <LibraryDialog title={t("续写下一集")} submitLabel={t("创建并打开")} close={() => setSequel(null)} save={async form => {
          if (!await onDeriveEpisode(sequel.id, "sequel", form.get("inherit") === "on")) {
            throw new Error("Sequel could not be created");
          }
        }}>
          <p>{sequel.title}</p>
          <label className="comic-sequel-option">
            <input type="checkbox" name="inherit" defaultChecked />
            {t("沿用上一集的角色与画风")}
          </label>
        </LibraryDialog>
      )}
    </div>
  );
}
