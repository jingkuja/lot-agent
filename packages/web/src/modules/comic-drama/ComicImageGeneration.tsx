import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComicDramaClip, ComicDramaDetail, ComicGenerationMode, ComicGenerationQuote, ComicImageRequest, ComicLibraryPage, ComicMaterial,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicGenerationApi } from "./generation-api.js";
import { comicGenerationError, GenerationQuoteDialog } from "./GenerationQuoteDialog.js";
import { ComicTakeStatus, ImageTakeActions, useGenerationHistory } from "./GenerationHistory.js";
import { comicLibraryApi } from "./library-api.js";
import { MediaPreview } from "./LibraryParts.js";
import { ClipVideoVersions, VideoTakeActions } from "./ComicVideoTakes.js";
import { ComicVideoReferences, type ChosenVideoReference } from "./ComicVideoReferences.js";
import { SaveMediaAsMaterialDialog } from "./SaveMediaAsMaterialDialog.js";

type Props = {
  detail: ComicDramaDetail;
  selected: string | null;
  select: (id: string) => void;
  getSaved: () => Promise<ComicDramaDetail | null>;
  disabled: boolean;
  initialMode?: ComicGenerationMode;
  quickAction?: { mode: ComicGenerationMode; token: number } | null;
  choose: (id: string) => void;
};

export function ComicImageGeneration({ detail, selected, select, getSaved, disabled, choose, initialMode = "keyframe", quickAction }: Props) {
  const { t } = useI18n();
  const [checked, setChecked] = useState<string[]>([]);
  const [quoting, setQuoting] = useState(false);
  const [quote, setQuote] = useState<ComicGenerationQuote | null>(null);
  const [error, setError] = useState("");
  const [batch, setBatch] = useState<ComicImageRequest | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState(initialMode);
  const [replaceAdopted, setReplaceAdopted] = useState(false);
  const [visual, setVisual] = useState<ChosenVideoReference[]>([]);
  const lastQuickToken = useRef(0);
  const isVideo = mode !== "keyframe";
  const pending = useRef(false);
  const clip = detail.clips.find(item => item.id === selected) ?? detail.clips[0];
  const selection = detail.clips.filter(item => checked.includes(item.id)).map(item => item.id);
  const scope = { resource: "series", id: detail.series.id } as const;
  const label = (id: string) => {
    const target = detail.clips.find(item => item.id === id);
    return target ? `${t("分镜 {0}", [target.ordinal])}${target.draft.scene ? " · " + target.draft.scene : ""}` : t("分镜已被删除");
  };
  const preview = useCallback(async (ids: string[], overrideMode?: ComicGenerationMode) => {
    const targetMode = overrideMode ?? mode;
    const targetIsVideo = targetMode !== "keyframe";
    if (pending.current || !ids.length) return;
    pending.current = true;
    setQuoting(true);
    setError("");
    try {
      const saved = await getSaved();
      if (!saved || saved.series.id !== scope.id) return;
      const targets = saved.clips.filter(item => ids.includes(item.id)).map(item => ({
        clipId: item.id, expectedRevision: item.revision, ...(targetIsVideo && replaceAdopted ? { replaceAdopted: true } : {}),
      }));
      if (targets.length !== ids.length) { setError("素材或分镜已更新，请重新询价"); return; }
      setQuote(await comicGenerationApi.preview(scope, { mode: targetMode, expectedSeriesRevision: saved.series.revision, targets,
        ...(targetIsVideo && visual.length ? { visualReferences: visual.map(({ kind, materialId, mediaId }) => ({ kind, materialId, mediaId })) } : {}),
      }));
    } catch (reason) { setError(comicGenerationError(reason)); }
    finally { setQuoting(false); pending.current = false; }
  }, [getSaved, mode, replaceAdopted, scope, visual]);

  useEffect(() => {
    if (!quickAction || quickAction.token === lastQuickToken.current || disabled) return;
    lastQuickToken.current = quickAction.token;
    setMode(quickAction.mode);
    const eligible = detail.clips.filter(item =>
      quickAction.mode === "keyframe" ? !item.progress?.keyframeApproved : !item.progress?.adoptedVideoTakeId,
    ).slice(0, 10).map(item => item.id);
    const targets = eligible.length ? eligible : detail.clips.slice(0, 10).map(item => item.id);
    if (targets.length) {
      setChecked(targets);
      void preview(targets, quickAction.mode);
    }
  }, [detail.clips, disabled, preview, quickAction]);
  return <div className="comic-board">
    <section className="comic-edit-card comic-generation-picker">
      <header><h2>{t(isVideo ? "生成视频" : "生成首帧")}</h2></header>
      <div className="comic-actions comic-generation-modes" role="group" aria-label={t("生成模式")}>
        {([["keyframe", "首帧图片"], ["from_keyframe", "用已确认首帧"], ["references", "直接参考生成"]] as const).map(([value, label]) =>
          <button type="button" key={value} aria-pressed={mode === value} disabled={quoting} onClick={() => setMode(value)}>{t(label)}</button>)}
      </div>
      {detail.clips.length === 0 && <p>{t("先在分镜中添加镜头")}</p>}
      <ul className="comic-generation-targets">
        {detail.clips.map(item => <li key={item.id}>
          {!disabled && <input type="checkbox" aria-label={t("选择{0}", [label(item.id)])} checked={selection.includes(item.id)}
            disabled={!selection.includes(item.id) && selection.length >= 10} onChange={event => {
              setChecked(event.target.checked ? [...selection, item.id] : selection.filter(id => id !== item.id));
            }} />}
          <button type="button" aria-pressed={item.id === clip?.id} onClick={() => select(item.id)}>{label(item.id)}</button>
        </li>)}
      </ul>
      {detail.clips.length > 0 && !disabled && <>
        {isVideo && <>
          <p className="comic-generation-note">{detail.series.videoModel ?? t("请先在剧集设置中选择支持的视频模型")}</p>
          <ComicVideoReferences references={visual} change={setVisual} />
          <label className="comic-video-replace"><input type="checkbox" checked={replaceAdopted}
            onChange={event => setReplaceAdopted(event.target.checked)} />{t("为已采用的分镜生成新版")}</label>
        </>}
        <p className="comic-generation-note">{t(isVideo ? "可勾选最多 10 个分镜批量生成视频。" : "可勾选最多 10 个分镜批量生成首帧。")}</p>
        <button className="primary" type="button" disabled={!selection.length || quoting} onClick={() => void preview(selection)}>
          {t("预览批量费用（{0}）", [selection.length])}
        </button>
      </>}
    </section>
    <div className="comic-generation-results">
      {error && <p className="comic-error" role="alert">{t(error)}</p>}
      {clip && (isVideo ? <ClipVideoVersions key={clip.id} seriesId={scope.id} clip={clip} refresh={refresh} disabled={disabled}
        choose={choose} quoting={quoting} preview={() => void preview([clip.id])} /> :
        <KeyframeHistory key={clip.id} seriesId={scope.id} clip={clip} refresh={refresh} disabled={disabled}
          quoting={quoting} preview={() => void preview([clip.id])} />)}
      {batch && batch.takes.length > 1 && <BatchStatus key={batch.id} request={batch} label={label} select={select}
        refreshed={() => setRefresh(value => value + 1)} />}
    </div>
    {quote && <GenerationQuoteDialog quote={quote} label={label} close={() => setQuote(null)}
      confirm={id => comicGenerationApi.confirm(scope, id)} submitted={result => {
        setBatch(result);
        setRefresh(value => value + 1);
        setChecked([]);
      }} />}
  </div>;
}

function KeyframeHistory({ seriesId, clip, refresh, disabled, quoting, preview }: {
  seriesId: string; clip: ComicDramaClip; refresh: number; disabled: boolean; quoting: boolean; preview: () => void;
}) {
  const { t, locale } = useI18n();
  const load = useCallback((signal: AbortSignal) => comicGenerationApi.keyframes(seriesId, clip.id, signal), [seriesId, clip.id]);
  const history = useGenerationHistory(load, 5_000, refresh);
  const [busyTake, setBusyTake] = useState<string | null>(null);
  const [pickingMaterial, setPickingMaterial] = useState(false);
  const [saveMediaId, setSaveMediaId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const reviewing = useRef(false);
  const approved = history.current?.approvedTakeId;
  const approvedMediaId = history.current?.approvedMediaId;
  const review = async (id: string) => {
    if (reviewing.current) return;
    reviewing.current = true;
    setBusyTake(id);
    setError("");
    try { await comicGenerationApi.approve(seriesId, clip.id, id, clip.revision); history.refresh(); }
    catch (reason) { setError(comicGenerationError(reason)); }
    finally { reviewing.current = false; setBusyTake(null); }
  };
  const uploadManual = async (file: File) => {
    if (reviewing.current) return;
    reviewing.current = true;
    setBusyTake("upload");
    setError("");
    try {
      await comicGenerationApi.uploadKeyframe(seriesId, clip.id, clip.revision, file, AbortSignal.timeout(30_000));
      history.refresh();
    } catch (reason) { setError(comicGenerationError(reason)); }
    finally { reviewing.current = false; setBusyTake(null); }
  };
  const selectManual = async (mediaId: string) => {
    if (reviewing.current) return;
    reviewing.current = true;
    setBusyTake("select");
    setError("");
    try {
      await comicGenerationApi.selectKeyframe(seriesId, clip.id, mediaId, clip.revision);
      setPickingMaterial(false);
      history.refresh();
    } catch (reason) { setError(comicGenerationError(reason)); }
    finally { reviewing.current = false; setBusyTake(null); }
  };
  return <section className="comic-edit-card">
    <header>
      <h2>{t("首帧审核 · 分镜 {0}", [clip.ordinal])}</h2>
      {!disabled && <div className="comic-actions">
        <label className="comic-file-button">
          {t("上传首帧")}
          <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={busyTake !== null} onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void uploadManual(file);
          }} />
        </label>
        <button type="button" disabled={busyTake !== null} onClick={() => setPickingMaterial(v => !v)}>{t("从素材库选择")}</button>
        <button type="button" className="primary" onClick={preview} disabled={quoting || history.current?.takes.some(take =>
          ["pending", "running", "recoverable", "unknown"].includes(take.state))}>
          {t("预览首帧费用")}
        </button>
      </div>}
    </header>
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    {pickingMaterial && <KeyframeMaterialPicker choose={id => void selectManual(id)} close={() => setPickingMaterial(false)} />}
    {history.failed && <button onClick={history.refresh}>{t("重新读取")}</button>}
    {!approved && approvedMediaId && (
      <article className="comic-library-card comic-manual-keyframe">
        <MediaPreview openOriginal media={{ id: approvedMediaId, hasThumbnail: true, durationMs: null }} title={t("已确认首帧")} />
        <strong>{t("已确认首帧")} · {t("上传或素材库")}</strong>
      </article>
    )}
    {!history.current ? <p role="status">{t("加载中…")}</p> :
      !history.current.takes.length && !approvedMediaId ? <p className="comic-generation-note">{t("暂无生成的首帧")}</p> :
      <div className="comic-library-grid">
        {history.current.takes.map(take => {
          const stale = take.clipRevision !== clip.revision;
          return <article className="comic-library-card" key={take.id}>
            {take.mediaId && <MediaPreview openOriginal media={{ id: take.mediaId, hasThumbnail: true, durationMs: null }} title={t("首帧图片")} />}
            <strong>{take.id === approved && !stale ? t("已确认首帧") : <ComicTakeStatus take={take} />}</strong>
            <small>{new Date(take.createdAt).toLocaleString(locale)}</small>
            {take.state === "ready" && stale && <small>{t("生成后分镜已修改")}</small>}
            <div className="comic-actions">
              {!disabled && take.state === "ready" && take.id !== approved && !stale &&
                <button type="button" disabled={busyTake !== null} onClick={() => void review(take.id)}>{t("确认此首帧")}</button>}
              {take.state === "ready" && take.mediaId && (
                <button type="button" onClick={() => setSaveMediaId(take.mediaId!)}>{t("另存为素材")}</button>
              )}
            </div>
            <ImageTakeActions take={take} refreshed={history.refresh} />
          </article>;
        })}
      </div>}
    {saveMediaId && <SaveMediaAsMaterialDialog mediaId={saveMediaId}
      defaultName={clip.draft.scene || t("分镜 {0}", [clip.ordinal])} close={() => setSaveMediaId(null)} />}
  </section>;
}

function KeyframeMaterialPicker({ choose, close }: { choose: (mediaId: string) => void; close: () => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"scene" | "prop" | "other">("scene");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<ComicLibraryPage<ComicMaterial> | "error" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void comicLibraryApi.materials({ kind, query, page: "1" }, controller.signal).then(res => {
      if (!controller.signal.aborted) setData({ ...res, entries: res.entries.filter(item => item.media.mime.startsWith("image/")) });
    }).catch(() => { if (!controller.signal.aborted) setData("error"); });
    return () => controller.abort();
  }, [kind, query]);
  return <div className="comic-track-picker">
    <div className="comic-actions">
      <select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
        <option value="scene">{t("场景")}</option><option value="prop">{t("道具")}</option><option value="other">{t("其他")}</option>
      </select>
      <input value={query} placeholder={t("搜索素材")} maxLength={120} onChange={e => setQuery(e.target.value)} />
      <button type="button" onClick={close}>{t("取消")}</button>
    </div>
    {data === null ? <p role="status">{t("加载中…")}</p> : data === "error" ? <p role="alert">{t("操作失败，请重试")}</p> : (
      data.entries.length === 0 ? <p>{t("暂无匹配的素材")}</p> : (
        <div className="comic-library-grid">
          {data.entries.map(item => (
            <article key={item.id} className="comic-library-card">
              <MediaPreview media={item.media} title={item.name} thumbOnly />
              <strong>{item.name}</strong>
              <button type="button" onClick={() => choose(item.media.id)}>{t("选作首帧")}</button>
            </article>
          ))}
        </div>
      )
    )}
  </div>;
}

function BatchStatus({ request, label, select, refreshed }: {
  request: ComicImageRequest; label: (id: string) => string; select: (id: string) => void; refreshed: () => void;
}) {
  const { t } = useI18n();
  const load = useCallback((signal: AbortSignal) => comicGenerationApi.status(request.id, signal), [request.id]);
  const history = useGenerationHistory(load);
  return <section className="comic-edit-card">
    <header><h2>{t("批量生成进度")}</h2></header>
    {history.failed && <button onClick={history.refresh}>{t("重新读取")}</button>}
    <ul className="comic-generation-status-list">{(history.current ?? request).takes.map(take => <li key={take.id}>
      <button type="button" onClick={() => select(take.targetId)}>{label(take.targetId)}</button>
      <ComicTakeStatus take={take} />
      {request.kind === "video" ? <VideoTakeActions take={take} refresh={() => { history.refresh(); refreshed(); }} /> :
        <ImageTakeActions take={take} refreshed={() => { history.refresh(); refreshed(); }} />}
    </li>)}</ul>
  </section>;
}
