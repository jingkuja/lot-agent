import { useCallback, useEffect, useRef, useState } from "react";
import type { ComicDramaClip, ComicMediaLinks, ComicTake, ComicVideoReceipt, ComicVideoTake } from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { ComicClipOriginBadge } from "./ComicHierarchyBar.js";
import { comicGenerationApi } from "./generation-api.js";
import { comicGenerationError } from "./GenerationQuoteDialog.js";
import { ComicTakeStatus, useGenerationHistory } from "./GenerationHistory.js";
import { comicLibraryApi } from "./library-api.js";
import { SaveComicFrame } from "./SaveComicFrame.js";

export type ComicClipOrigin = {
  dramaTitle: string;
  episodeNo: number;
  episodeTitle: string;
  totalClips: number;
};

export function ClipVideoVersions({ seriesId, clip, origin, refresh, disabled, quoting, preview, choose, onSeriesChanged }: {
  seriesId: string; clip: ComicDramaClip; origin?: ComicClipOrigin; refresh: number; disabled: boolean; quoting: boolean; preview: () => void;
  choose: (id: string) => void; onSeriesChanged?: () => void;
}) {
  const { t } = useI18n();
  const load = useCallback((signal: AbortSignal) => comicGenerationApi.videos(seriesId, clip.id, signal), [seriesId, clip.id]);
  const history = useGenerationHistory(load, 5_000, refresh);
  const busy = history.current?.some(take => ["pending", "running", "unknown", "recoverable"].includes(take.state));
  const selectionRevision = history.current?.[0]?.clipSelectionRevision ?? clip.selectionRevision ?? 1;
  return <section className="comic-edit-card">
    <header>
      <div>
        {origin && (
          <ComicClipOriginBadge
            dramaTitle={origin.dramaTitle}
            episodeNo={origin.episodeNo}
            episodeTitle={origin.episodeTitle}
            clipOrdinal={clip.ordinal}
            totalClips={origin.totalClips}
          />
        )}
        <h2>{t("视频版本 · 分镜 {0}", [clip.ordinal])}</h2>
      </div>
      {!disabled && <button type="button" disabled={quoting || busy} onClick={preview}>{t("预览视频费用")}</button>}
    </header>
    {history.failed && <button type="button" onClick={history.refresh}>{t("重新读取")}</button>}
    {!history.current ? <p role="status">{t("加载中…")}</p> :
      !history.current.length ? <p className="comic-generation-note">{t("暂无视频版本")}</p> :
      <div className="comic-library-grid">{history.current.map(take => <VideoTakeCard key={take.id} take={take}
        choose={() => choose(take.id)}
        adopt={disabled || take.adopted ? undefined : async () => {
          await comicGenerationApi.adopt(seriesId, clip.id, take.id, clip.revision, selectionRevision);
          onSeriesChanged?.();
        }}
        refresh={() => { history.refresh(); onSeriesChanged?.(); }} />)}</div>}
  </section>;
}

export function VideoTakeActions({ take, refresh, allowReceipt = true }: { take: ComicTake; refresh: () => void; allowReceipt?: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [receiptOpen, openReceipt] = useState(false);
  const perform = async (action: "cancel" | "release" | "recover") => {
    if (pending.current) return;
    if (action === "release" && !window.confirm(t("原请求可能已扣费。释放后可重新报价，新请求可能再次扣费。确认释放？"))) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await comicGenerationApi.videoAction(take.id, action); refresh(); }
    catch (reason) { setError(comicGenerationError(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <>
    <div className="comic-actions">
      {(take.state === "pending" || take.state === "running" || take.creditCheck) && !take.cancelRequested &&
        <button type="button" disabled={busy} onClick={() => void perform("cancel")}>{t("停止此项")}</button>}
      {take.state === "recoverable" && !take.creditCheck && <button type="button" disabled={busy || !take.canRecover}
        onClick={() => void perform("recover")}>{t("恢复原任务")}</button>}
      {take.state === "unknown" && <button type="button" disabled={busy} onClick={() => void perform("release")}>{t("释放旧提交")}</button>}
      {allowReceipt && !["pending", "cancelled"].includes(take.state) &&
        <button type="button" disabled={busy} onClick={() => openReceipt(true)}>{t("查看回执")}</button>}
    </div>
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    {receiptOpen && <VideoReceipt takeId={take.id} close={() => openReceipt(false)} />}
  </>;
}

function VideoReceipt({ takeId, close }: { takeId: string; close: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [receipt, setReceipt] = useState<ComicVideoReceipt | "error" | null>(null);
  useEffect(() => {
    ref.current?.showModal();
    const controller = new AbortController();
    void comicGenerationApi.receipt(takeId, controller.signal).then(row => {
      if (!controller.signal.aborted) setReceipt(row);
    }).catch(() => { if (!controller.signal.aborted) setReceipt("error"); });
    return () => controller.abort();
  }, [takeId]);
  return <dialog ref={ref} className="comic-dialog comic-quote" aria-label={t("视频提交回执")} onCancel={event => { event.preventDefault(); close(); }}>
    <h2>{t("视频提交回执")}</h2>
    {receipt === "error" ? <p role="alert">{t("操作失败，请重试")}</p> : !receipt ? <p role="status">{t("加载中…")}</p> :
      <dl className="comic-character-profile">
        <dt>{t("供应商任务 ID")}</dt><dd>{receipt.vendorId ?? "—"}</dd>
        <dt>{t("网关追踪 ID")}</dt><dd>{receipt.gatewayRequestId ?? "—"}</dd>
        <dt>{t("网关状态码")}</dt><dd>{receipt.httpStatus ?? "—"}</dd>
      </dl>}
    <div className="comic-actions comic-dialog-actions"><button type="button" onClick={close}>{t("关闭")}</button></div>
  </dialog>;
}

export function VideoTakeCard({ take, adopt, refresh, open, choose, addToEdit, selected = false }: {
  take: ComicVideoTake; adopt?: () => Promise<unknown>; refresh: () => void; open?: () => void;
  choose?: () => void; addToEdit?: () => void; selected?: boolean;
}) {
  const { t, locale } = useI18n();
  const [links, setLinks] = useState<ComicMediaLinks | "error" | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | undefined>(undefined);
  const [attempt, reload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selectionConflict, setSelectionConflict] = useState(false);
  const [frame, setFrame] = useState<number | null>(null);
  const [savedFrame, setSavedFrame] = useState(false);
  const renewed = useRef(false);
  const hoverPlaying = useRef(false);
  const player = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!take.mediaId) return;
    void comicLibraryApi.links(take.mediaId, controller.signal).then(result => {
      if (!controller.signal.aborted) setLinks(result);
    }).catch(() => { if (!controller.signal.aborted) setLinks("error"); });
    return () => controller.abort();
  }, [attempt, take.mediaId]);
  useEffect(() => {
    if (!take.posterMediaId) { setPosterUrl(undefined); return; }
    const controller = new AbortController();
    void comicLibraryApi.links(take.posterMediaId, controller.signal).then(result => {
      if (!controller.signal.aborted) setPosterUrl(result.thumbnailUrl ?? result.url);
    }).catch(() => {});
    return () => controller.abort();
  }, [take.posterMediaId]);
  const performAdopt = async () => {
    if (!adopt || saving) return;
    setSaving(true);
    setError("");
    setSelectionConflict(false);
    try { await adopt(); refresh(); }
    catch (reason) {
      setError(comicGenerationError(reason));
      setSelectionConflict(reason instanceof ApiClientError && reason.code === "SELECTION_CONFLICT");
    }
    finally { setSaving(false); }
  };
  return <article className="comic-library-card comic-video-card">
    {links === "error" ? <button type="button" onClick={() => { renewed.current = false; reload(value => value + 1); }}>{t("重新获取预览")}</button> :
      links && <video ref={player} controls playsInline poster={posterUrl} preload={selected ? "metadata" : "none"}
        aria-label={t("视频预览 · 版本 {0}", [take.version])} src={links.url}
        onMouseEnter={() => {
          const video = player.current;
          if (!selected && video && video.paused) {
            video.muted = true;
            hoverPlaying.current = true;
            void video.play().catch(() => { hoverPlaying.current = false; });
          }
        }}
        onMouseLeave={() => {
          const video = player.current;
          if (hoverPlaying.current && video) {
            hoverPlaying.current = false;
            video.pause();
            video.currentTime = 0;
          }
        }}
        onPlay={() => { if (!player.current?.muted) hoverPlaying.current = false; }}
        onError={() => {
          if (renewed.current) setLinks("error");
          else { renewed.current = true; reload(value => value + 1); }
        }} />}
    {(open || selected) && take.dramaTitle && (
      <small className="comic-take-origin">
        {take.dramaTitle}{take.episodeNo ? ` · ${t("第 {0} 集", [take.episodeNo])}` : ""}
      </small>
    )}
    <strong>
      {open || selected ? take.seriesTitle + " · " : ""}
      {take.ordinal !== null ? t("分镜 {0}", [take.ordinal]) + " · " : ""}
      {t("版本 {0}", [take.version])}{take.adopted && " · " + t("已采用")}
    </strong>
    {(open || selected) && take.scene && <small>{take.scene}</small>}
    <small>{take.modelId} · {t("{0} 秒视频", [+(take.durationMs / 1000).toFixed(2)])}</small>
    <small>{new Date(take.completedAt ?? take.createdAt).toLocaleString(locale)}</small>
    {!selected && <><ComicTakeStatus take={take} /><VideoTakeActions take={take} refresh={refresh} /></>}
    {take.state === "ready" && !selected && <div className="comic-actions">
      {addToEdit && <button type="button" onClick={addToEdit}>{t("加入剪辑台")}</button>}
      {choose && <button type="button" onClick={choose}>{t("选作剪辑片源")}</button>}
      {adopt && <button type="button" className="primary" onClick={() => void performAdopt()} disabled={saving}>{t("采用此版本")}</button>}
      {links && links !== "error" && <>
        <a href={links.url} download={`comic-v${take.version}.mp4`}>{t("下载视频")}</a>
        <button type="button" onClick={() => {
          setSavedFrame(false);
          setFrame(Math.min(take.durationMs - 1, Math.round((player.current?.currentTime ?? 0) * 1000)));
        }}>{t("截帧另存")}</button>
      </>}
      {open && take.ordinal !== null && <button type="button" onClick={open}>{t("打开对应分镜")}</button>}
    </div>}
    {savedFrame && <small role="status">{t("已保存截帧")}</small>}
    {error && <div className="comic-error" role="alert">
      <span>{t(error)}</span>
      {selectionConflict && <button type="button" onClick={() => { setError(""); setSelectionConflict(false); refresh(); }}>{t("重新读取")}</button>}
    </div>}
    {frame !== null && <SaveComicFrame take={take} initialTime={frame} close={() => setFrame(null)} saved={() => setSavedFrame(true)} />}
  </article>;
}
