import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  analyzeComicModelSwitch, COMIC_SCRIPT_MAX_CHARS, comicVideoModel, comicVideoOptions, resolveComicEpisodeMasterScript,
  selectComicVideoModel, type ComicDramaClip, type ComicDramaEpisodeBrief, type ComicDramaEpisodeCreateInput,
  type ComicDramaSeries, type ComicDramaSeriesInput, type ComicDramaTreeEntry, type ComicModelSwitchIssue,
  type ComicSeriesCast, type ResolvedComicEpisodeScript,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicDramaApi } from "./api.js";
import { comicLibraryApi } from "./library-api.js";
import { ChoiceSelect, useComicChoices } from "./LibraryParts.js";

export type ComicDramaModel = { id: string; name?: string };
export type PresetDramaTarget = {
  id: string;
  title: string;
  styleKey: string;
  aspectRatio: ComicDramaSeriesInput["aspectRatio"];
  videoModel: string | null;
  nextEpisodeNo: number;
  latestEpisodeId?: string | null;
  castCount?: number;
  episodes?: readonly ComicDramaEpisodeBrief[];
  scriptContent?: string;
};

export type SeriesModelAdaptOptions = { apply: boolean; clampDuration: boolean };

export type EpisodeDialogPayload = ComicDramaSeriesInput & Pick<ComicDramaEpisodeCreateInput, "initialScript">;

export function SeriesDialog({ series, clips, cast, presetDrama, models, close, save, error }: {
  series?: ComicDramaSeries;
  clips?: readonly ComicDramaClip[];
  cast?: readonly ComicSeriesCast[];
  presetDrama?: PresetDramaTarget;
  models: readonly ComicDramaModel[];
  close: () => void;
  save: (fields: EpisodeDialogPayload, modelAdapt?: SeriesModelAdaptOptions) => Promise<boolean>;
  error: string | null;
}) {
  const { t, locale } = useI18n();
  const styles = useComicChoices("style");
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [dramas, setDramas] = useState<ComicDramaTreeEntry[]>([]);
  const [selectedDramaId, setSelectedDramaId] = useState(series?.dramaId ?? presetDrama?.id ?? "");
  const [castSource, setCastSource] = useState<"drama" | "none" | string>(
    presetDrama?.castCount ? "drama" : (presetDrama?.latestEpisodeId || "drama"),
  );
  const initialEpNo = series?.episodeNo ?? presetDrama?.nextEpisodeNo ?? 1;
  const initialResolved = resolveComicEpisodeMasterScript(presetDrama?.scriptContent ?? "", initialEpNo);
  const [episodeNo, setEpisodeNo] = useState(String(initialEpNo));
  const [title, setTitle] = useState(() => {
    if (series) return series.title;
    if (initialResolved.matched === "episode" && initialResolved.title) return initialResolved.title;
    return initialResolved.matched !== "none" ? t("第 {0} 集", [initialEpNo]) : "";
  });
  const [initialScript, setInitialScript] = useState(() => (
    !series && initialResolved.matched !== "none" ? initialResolved.content : ""
  ));
  const titleTouched = useRef(false);
  const scriptTouched = useRef(false);
  const [styleKey, setStyleKey] = useState(series?.styleKey ?? presetDrama?.styleKey ?? "thick_painting");
  const [aspectRatio, setAspectRatio] = useState<ComicDramaSeriesInput["aspectRatio"]>(
    series?.aspectRatio ?? presetDrama?.aspectRatio ?? "9:16",
  );
  const [videoModel, setVideoModel] = useState(
    series?.videoModel ?? presetDrama?.videoModel ?? selectComicVideoModel(models) ?? "",
  );
  const [applyAdapt, setApplyAdapt] = useState(true);
  const [clampDuration, setClampDuration] = useState(false);
  const [preferredVideo, setPreferredVideo] = useState<string | null>(null);
  const videoTouched = useRef(false);
  const available = comicVideoOptions(models, videoModel);
  const switchReport = useMemo(
    () => (series && clips?.length && videoModel ? analyzeComicModelSwitch(clips, videoModel, { clampDuration, cast }) : null),
    [series, clips, videoModel, clampDuration, cast],
  );
  const describeSwitchIssue = (issue: ComicModelSwitchIssue): string => {
    switch (issue.code) {
      case "DURATION_EXCEEDS_MAX":
        return t("时长 {0} 秒超过上限 {1} 秒（建议压缩或手动拆分）", [+(issue.durationMs / 1000).toFixed(1), issue.maxSeconds]);
      case "DURATION_OUT_OF_RANGE":
        return t("分镜时长 {0} 秒超出当前模型范围（{1}–{2} 整秒）", [+(issue.durationMs / 1000).toFixed(1), issue.minSeconds, issue.maxSeconds]);
      case "RESOLUTION_UNSUPPORTED":
        return t("分辨率 {0} 将自动映射为 {1}", [issue.from, issue.to]);
      case "IMAGE_LIMIT_EXCEEDED":
        return t("参考图 {0} 张超限（上限 {1} 张，将按优先级折叠 {2} 张）", [issue.totalImages, issue.limit, issue.excess]);
      case "FILE_LIMIT_EXCEEDED":
        return t("参考文件共 {0} 个超限（上限 {1} 个）", [issue.totalFiles, issue.limit]);
      case "AUDIO_COUNT_EXCEEDED":
        return t("参考音频 {0} 段超过上限 {1} 段", [issue.count, issue.limit]);
      case "VIDEO_COUNT_EXCEEDED":
        return t("参考视频 {0} 段超过上限 {1} 段", [issue.count, issue.limit]);
      case "AUDIO_ONLY_UNSUPPORTED":
        return t("当前模型不支持仅传参考音频，请至少补充 1 张参考图或 1 段参考视频");
      case "EXTEND_UNSUPPORTED":
        return t("目标模型不支持视频延长，将暂存原开关设置");
    }
  };

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void comicDramaApi.listDramas(new URLSearchParams({ archived: "false" }), controller.signal).then(data => {
      if (!controller.signal.aborted) setDramas(data.dramas);
    }).catch(() => {});
    if (!series) {
      void comicLibraryApi.settings(controller.signal).then(data => {
        if (!controller.signal.aborted) setPreferredVideo(data.preferences.defaultVideoModel ?? null);
      }).catch(() => {});
    }
    return () => controller.abort();
  }, [series]);
  useEffect(() => {
    if (!series && !presetDrama?.videoModel && !videoTouched.current) {
      setVideoModel(selectComicVideoModel(models, preferredVideo) ?? "");
    }
  }, [series, presetDrama, models, preferredVideo]);

  const chooseVideoModel = (id: string) => {
    videoTouched.current = true;
    setVideoModel(id);
  };

  const selectedDrama = dramas.find(d => d.id === selectedDramaId);
  const dramaEpisodes = presetDrama?.episodes ?? selectedDrama?.episodes ?? [];
  const dramaCastCount = presetDrama?.castCount ?? selectedDrama?.castCount ?? 0;
  const resolvedDramaTitle = presetDrama?.title ?? selectedDrama?.title ?? series?.seriesGroup ?? "";
  const masterScript = presetDrama?.scriptContent ?? selectedDrama?.scriptContent ?? "";
  const styleLabel = styles.find(style => style.key === styleKey)?.labels[locale] ?? styleKey;
  const videoLabel = comicVideoModel(videoModel)?.label ?? (videoModel || t("沿用默认视频模型"));
  const parsedEpNo = Math.max(1, Number(episodeNo) || 1);
  const resolvedMaster = useMemo(
    () => resolveComicEpisodeMasterScript(masterScript, parsedEpNo),
    [masterScript, parsedEpNo],
  );
  const defaultTitleFor = (resolved: ResolvedComicEpisodeScript, epNo: number) => {
    if (resolved.matched === "episode" && resolved.title) return resolved.title;
    return resolved.matched !== "none" ? t("第 {0} 集", [epNo]) : "";
  };

  useEffect(() => {
    if (series) return;
    if (!titleTouched.current) {
      const nextTitle = resolvedMaster.matched === "episode" && resolvedMaster.title
        ? resolvedMaster.title
        : resolvedMaster.matched !== "none"
          ? t("第 {0} 集", [parsedEpNo])
          : "";
      setTitle(prev => (prev === nextTitle ? prev : nextTitle));
    }
    if (!scriptTouched.current) {
      const nextScript = resolvedMaster.matched !== "none" ? resolvedMaster.content : "";
      setInitialScript(prev => (prev === nextScript ? prev : nextScript));
    }
  }, [series, resolvedMaster, parsedEpNo, t]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const get = (name: string) => String(form.get(name) ?? "").trim();
    const submittedTitle = get("title") || title.trim();
    const submittedScript = String(form.get("initialScript") ?? initialScript);
    const inherit = castSource !== "none";
    const sourceSeriesId = castSource !== "drama" && castSource !== "none" ? castSource : undefined;
    setBusy(true);
    try {
      const adapt = switchReport && switchReport.affectedClips.length > 0
        ? { apply: applyAdapt, clampDuration }
        : undefined;
      if (await save({
        title: submittedTitle,
        logline: get("logline"),
        ...(selectedDramaId ? { dramaId: selectedDramaId } : {}),
        seriesGroup: resolvedDramaTitle || null,
        episodeNo: parsedEpNo,
        styleKey,
        aspectRatio,
        videoModel: videoModel || null,
        ...(!series ? {
          inheritCastAndStyle: inherit,
          ...(sourceSeriesId ? { sourceSeriesId } : {}),
          initialScript: submittedScript,
        } : {}),
      }, adapt)) close();
    } finally { setBusy(false); }
  }

  const wideDialog = !series && (resolvedMaster.matched !== "none" || initialScript.length > 0);

  return (
    <dialog ref={dialog} className={`comic-dialog${wideDialog ? " comic-dialog--wide" : ""}`} aria-labelledby="comic-dialog-title"
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      <form onSubmit={submit}>
        <h2 id="comic-dialog-title">
          {series ? t("编辑分集") : t("创建第 {0} 集", [parsedEpNo])}
        </h2>
        <fieldset disabled={busy}>
          {!series && resolvedDramaTitle && (
            <div className="comic-dialog-parent-pill">
              <small>{t("所属整部剧集")}</small>
              <strong>《{resolvedDramaTitle}》</strong>
            </div>
          )}
          {series && dramas.length > 1 && (
            <label>{t("所属整部剧集")}
              <select aria-label={t("所属整部剧集")} value={selectedDramaId} onChange={event => setSelectedDramaId(event.target.value)}>
                {!dramas.some(d => d.id === series.dramaId) && (
                  <option value={series.dramaId}>{series.seriesGroup ?? series.title}</option>
                )}
                {dramas.map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title}（{t("共 {0} 集", [entry.episodeCount])}）
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="comic-fields comic-episode-title-row">
            <label>{t("集数")}
              <input type="number" name="episodeNo" min={1} max={2147483647} value={episodeNo}
                onChange={event => setEpisodeNo(event.target.value)} />
            </label>
            <label>{t("分集名称")}
              <input name="title" required maxLength={120} value={title}
                onChange={event => { titleTouched.current = true; setTitle(event.target.value); }}
                placeholder={t("例如：第 {0} 集：雨夜风铃", [parsedEpNo])} autoFocus />
            </label>
          </div>
          <label>{t("本集梗概（可选）")}
            <textarea name="logline" maxLength={2000} defaultValue={series?.logline} rows={2}
              placeholder={t("概括本集主要剧情节点与结尾钩子")} />
          </label>
          {!series && (
            <>
              <label>{t("本集剧本（可选）")}
                {masterScript.trim() && (
                  <div className="comic-dialog-script-hint" role="status">
                    <span>
                      {resolvedMaster.matched === "episode"
                        ? t("已从全剧剧本自动带入第 {0} 集内容，可直接修改", [parsedEpNo])
                        : resolvedMaster.matched === "whole_fallback"
                          ? t("未识别到分集标题，已带入全剧剧本，可直接删改保留本集内容")
                          : t("全剧剧本中未找到第 {0} 集分段，可手动填写或调整集数", [parsedEpNo])}
                      {resolvedMaster.truncated ? ` · ${t("已截取前 20,000 个字符")}` : ""}
                    </span>
                    {resolvedMaster.matched !== "none" && initialScript !== resolvedMaster.content && (
                      <button
                        type="button"
                        onClick={() => {
                          scriptTouched.current = false;
                          setInitialScript(resolvedMaster.content);
                          if (!titleTouched.current) {
                            setTitle(defaultTitleFor(resolvedMaster, parsedEpNo));
                          }
                        }}
                      >
                        {resolvedMaster.matched === "episode"
                          ? t("恢复第 {0} 集原文", [parsedEpNo])
                          : t("恢复全剧剧本")}
                      </button>
                    )}
                  </div>
                )}
                <textarea
                  name="initialScript"
                  maxLength={COMIC_SCRIPT_MAX_CHARS}
                  rows={masterScript.trim() ? 8 : 3}
                  value={initialScript}
                  onChange={event => { scriptTouched.current = true; setInitialScript(event.target.value); }}
                  placeholder={t("可粘贴本集剧本片段，也可创建后再写或让导演助手拆分")}
                />
              </label>
              {dramaEpisodes.length > 0 ? (
                <label>{t("角色带入方式")}
                  <select aria-label={t("角色带入方式")} value={castSource} onChange={event => setCastSource(event.target.value)}>
                    <option value="drama">
                      {dramaCastCount > 0
                        ? t("沿用全剧角色表（{0} 名）", [dramaCastCount])
                        : t("沿用全剧角色表")}
                    </option>
                    {dramaEpisodes.map(ep => (
                      <option key={ep.id} value={ep.id}>
                        {t("沿用第 {0} 集 · {1}", [ep.episodeNo, ep.title])}
                      </option>
                    ))}
                    <option value="none">{t("暂不带入角色")}</option>
                  </select>
                </label>
              ) : (
                <label className="comic-sequel-option">
                  <input type="checkbox" checked={castSource !== "none"}
                    onChange={event => setCastSource(event.target.checked ? "drama" : "none")} />
                  {dramaCastCount > 0
                    ? t("自动带入全剧角色（{0} 名）", [dramaCastCount])
                    : t("自动带入全剧角色与默认画风")}
                </label>
              )}
              <details className="comic-episode-defaults">
                <summary>
                  {t("画风与模型（默认沿用整部剧：{0} · {1} · {2}）", [styleLabel, aspectRatio, videoLabel])}
                </summary>
                <div className="comic-fields">
                  <label>{t("画风")}
                    <ChoiceSelect domain="style" name="styleKey" existing={presetDrama?.styleKey}
                      value={styleKey} onChange={event => setStyleKey(event.target.value)} required />
                  </label>
                  <label>{t("画幅")}
                    <select name="aspectRatio" value={aspectRatio}
                      onChange={event => setAspectRatio(event.target.value as ComicDramaSeriesInput["aspectRatio"])}>
                      <option>9:16</option><option>16:9</option><option>1:1</option>
                    </select>
                  </label>
                </div>
                <label>{t("视频模型")}
                  <select name="videoModel" value={videoModel} onChange={event => chooseVideoModel(event.target.value)}>
                    {!available.length && <option value="">{t("沿用默认视频模型")}</option>}
                    {available.map(model => <option key={model.id} value={model.id}>{t(model.label)}</option>)}
                  </select>
                </label>
              </details>
            </>
          )}
          {series && (
            <>
              <div className="comic-fields">
                <label>{t("画风")}
                  <ChoiceSelect domain="style" name="styleKey" existing={series.styleKey}
                    value={styleKey} onChange={event => setStyleKey(event.target.value)} required />
                </label>
                <label>{t("画幅")}
                  <select name="aspectRatio" value={aspectRatio}
                    onChange={event => setAspectRatio(event.target.value as ComicDramaSeriesInput["aspectRatio"])}>
                    <option>9:16</option><option>16:9</option><option>1:1</option>
                  </select>
                </label>
              </div>
              <label>{t("视频模型")}
                <select name="videoModel" value={videoModel} onChange={event => chooseVideoModel(event.target.value)}>
                  {!series.videoModel && <option value="">{t("稍后选择")}</option>}
                  {series.videoModel && !available.some(model => model.id === series.videoModel) && (
                    <option value={series.videoModel}>{series.videoModel}</option>
                  )}
                  {available.map(model => <option key={model.id} value={model.id}>{t(model.label)}</option>)}
                </select>
              </label>
            </>
          )}
          {switchReport && switchReport.affectedClips.length > 0 && (
            <div className="comic-compat-box" role="status">
              <strong>{t("模型切换兼容检查 · {0} 个分镜受影响", [switchReport.affectedClips.length])}</strong>
              <ul>
                {switchReport.affectedClips.slice(0, 8).map(clip => (
                  <li key={clip.clipId}>
                    <strong>{t("分镜 {0}", [clip.clipOrdinal])}{clip.scene ? ` · ${clip.scene}` : ""}</strong>
                    <small>
                      {clip.issues.length > 0
                        ? clip.issues.map(describeSwitchIssue).join("；")
                        : t("切回此模型后可自动恢复先前折叠的参考图与原分辨率")}
                    </small>
                  </li>
                ))}
                {switchReport.affectedClips.length > 8 && (
                  <li><small>{t("另有 {0} 个受影响分镜…", [switchReport.affectedClips.length - 8])}</small></li>
                )}
              </ul>
              {(switchReport.autoAdaptableCount > 0 || switchReport.restorableCount > 0) && (
                <label className="comic-sequel-option">
                  <input type="checkbox" checked={applyAdapt} onChange={event => setApplyAdapt(event.target.checked)} />
                  {t("保存并一键兼容适配（保留原绑定，切回高规格模型可恢复）")}
                </label>
              )}
              {switchReport.durationNeedsAttentionCount > 0 && (
                <label className="comic-sequel-option">
                  <input type="checkbox" checked={clampDuration} onChange={event => setClampDuration(event.target.checked)} />
                  {t("同时将超长分镜时长压缩至 {0} 秒上限（不勾选则保留原时长供手动拆分）", [switchReport.targetProfile.shotMaxSeconds])}
                </label>
              )}
            </div>
          )}
          {error && <p className="comic-error" role="alert">{error}</p>}
          <div className="comic-actions">
            <button type="button" onClick={close}>{t("取消")}</button>
            <button className="primary" type="submit">{t(series ? "保存" : "创建并进入本集")}</button>
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}
