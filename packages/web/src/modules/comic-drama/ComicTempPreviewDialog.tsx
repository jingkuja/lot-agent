import { useCallback, useEffect, useRef, useState } from "react";
import { comicRenderIssue, type ComicEdit, type ComicTimeline } from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { comicEditApi, comicRenderError, editError } from "./edit-api.js";

type Stage = "saving" | "rendering" | "ready" | "error";

function waitMs(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function ComicTempPreviewDialog({
  aspectRatio, ensureSaved, fixOverflowAndSave, close,
}: {
  aspectRatio: ComicTimeline["aspectRatio"];
  ensureSaved: () => Promise<ComicEdit | null>;
  fixOverflowAndSave?: () => Promise<ComicEdit | null>;
  close: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const activeRenderIdRef = useRef<string | null>(null);
  const runSeqRef = useRef(0);
  const ensureSavedRef = useRef(ensureSaved);
  const fixOverflowRef = useRef(fixOverflowAndSave);
  ensureSavedRef.current = ensureSaved;
  fixOverflowRef.current = fixOverflowAndSave;

  const [stage, setStage] = useState<Stage>("saving");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [errorCode, setErrorCode] = useState("");

  const detachVideo = () => {
    const player = videoRef.current;
    if (!player) return;
    try {
      player.pause();
      player.removeAttribute("src");
      player.load();
    } catch { /* ignore in test DOM */ }
  };

  const disposeActiveRender = useCallback((keepalive = false) => {
    const renderId = activeRenderIdRef.current;
    activeRenderIdRef.current = null;
    detachVideo();
    if (renderId) {
      void comicEditApi.removeRender(renderId, keepalive).catch(() => {});
    }
  }, []);

  const handleClose = useCallback(() => {
    runSeqRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    disposeActiveRender(false);
    close();
  }, [close, disposeActiveRender]);

  const startPreview = useCallback(async (useFix = false) => {
    const seq = ++runSeqRef.current;
    controllerRef.current?.abort();
    disposeActiveRender(false);
    const controller = new AbortController();
    controllerRef.current = controller;

    setStage("saving");
    setElapsedSec(0);
    setVideoUrl(null);
    setDurationMs(0);
    setErrorMsg("");
    setErrorCode("");

    try {
      const saved = useFix && fixOverflowRef.current
        ? await fixOverflowRef.current()
        : await ensureSavedRef.current();
      if (controller.signal.aborted || runSeqRef.current !== seq) return;
      if (!saved) {
        setStage("error");
        setErrorMsg("请先保存工程修改后重试");
        return;
      }

      const issue = comicRenderIssue(saved.timeline, 30);
      if (issue) {
        setStage("error");
        setErrorCode(issue);
        setErrorMsg(comicRenderError(issue));
        return;
      }

      setStage("rendering");
      const started = await comicEditApi.startRender(saved.id, {
        expectedRevision: saved.revision,
        requestId: crypto.randomUUID(),
        fpsMode: "auto",
        ephemeral: true,
      });
      if (controller.signal.aborted || runSeqRef.current !== seq) {
        void comicEditApi.removeRender(started.id).catch(() => {});
        return;
      }
      activeRenderIdRef.current = started.id;

      let current = started;
      while (current.status === "pending" || current.status === "running") {
        const ok = await waitMs(600, controller.signal);
        if (!ok || runSeqRef.current !== seq) return;
        current = await comicEditApi.render(started.id, controller.signal);
        if (controller.signal.aborted || runSeqRef.current !== seq) return;
      }

      if (current.status !== "ready" || !current.mediaId) {
        const code = current.error ?? (current.status === "cancelled" ? "RENDER_CANCEL_UNAVAILABLE" : "RENDER_FAILED");
        setStage("error");
        setErrorCode(code);
        setErrorMsg(current.status === "cancelled" ? "临时预览已取消" : comicRenderError(code));
        return;
      }

      const download = await comicEditApi.downloadRender(started.id, true);
      if (controller.signal.aborted || runSeqRef.current !== seq) return;
      setDurationMs(current.durationMs);
      setVideoUrl(download.url);
      setStage("ready");
    } catch (reason) {
      if (controller.signal.aborted || runSeqRef.current !== seq) return;
      setStage("error");
      setErrorCode(reason instanceof ApiClientError && reason.code ? reason.code : "");
      setErrorMsg(editError(reason));
    }
  }, [disposeActiveRender]);

  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) {
      if (typeof el.showModal === "function") {
        try { el.showModal(); } catch { el.setAttribute("open", ""); }
      } else {
        el.setAttribute("open", "");
      }
    }
    void startPreview(false);

    const onPageHide = () => { disposeActiveRender(true); };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      runSeqRef.current += 1;
      controllerRef.current?.abort();
      disposeActiveRender(false);
    };
  }, [disposeActiveRender, startPreview]);

  useEffect(() => {
    if (stage !== "rendering") return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSec(Math.max(1, Math.floor((Date.now() - startedAt) / 1000)));
    }, 500);
    return () => clearInterval(timer);
  }, [stage]);

  return (
    <dialog
      ref={dialogRef}
      className="comic-dialog comic-temp-preview-dialog"
      aria-label={t("临时成片预览")}
      onCancel={event => {
        event.preventDefault();
        handleClose();
      }}
      onClick={event => {
        if (event.target === dialogRef.current) handleClose();
      }}
    >
      <div className="comic-temp-preview-head">
        <div className="comic-actions">
          <h2>{t("临时成片预览")}</h2>
          <span className="comic-pill" data-tone="idle">{t("关闭即删除")}</span>
        </div>
        <button type="button" className="comic-temp-close-icon" aria-label={t("关闭")} onClick={handleClose}>×</button>
      </div>

      {stage === "saving" || stage === "rendering" ? (
        <div className="comic-temp-preview-loading" role="status">
          <p>
            {stage === "saving"
              ? t("正在保存修改…")
              : t("正在合成临时成片…（已用 {0} 秒）", [elapsedSec])}
          </p>
          <div className="comic-temp-progress-bar" aria-hidden="true"><i /></div>
          <div className="comic-actions comic-dialog-actions">
            <button type="button" onClick={handleClose}>{t("取消")}</button>
          </div>
        </div>
      ) : stage === "ready" && videoUrl ? (
        <>
          <div className="comic-temp-preview-stage" style={{ aspectRatio: aspectRatio.replace(":", "/") }}>
            <video
              ref={videoRef}
              key={videoUrl}
              src={videoUrl}
              controls
              autoPlay
              playsInline
              preload="auto"
              aria-label={t("临时成片")}
              onError={() => {
                setStage("error");
                setErrorMsg("临时成片播放失败，请重新试看");
              }}
            />
          </div>
          <div className="comic-temp-preview-foot">
            <small className="comic-generation-note">
              {t("时长 {0} 秒 · 关闭弹窗自动删除，不占用导出历史", [Number((durationMs / 1000).toFixed(2))])}
            </small>
            <div className="comic-actions">
              <button type="button" onClick={() => void startPreview(false)}>{t("重新试看")}</button>
              <button type="button" className="primary" onClick={handleClose}>{t("关闭并删除")}</button>
            </div>
          </div>
        </>
      ) : (
        <div className="comic-temp-preview-error">
          <p className="comic-error" role="alert">{t(errorMsg || "合成失败，请检查素材后重新导出")}</p>
          <div className="comic-actions comic-dialog-actions">
            <button type="button" onClick={handleClose}>{t("关闭")}</button>
            {errorCode === "RENDER_TRACK_OVERFLOW" && fixOverflowAndSave && (
              <button type="button" className="primary" onClick={() => void startPreview(true)}>
                {t("一键修复超出项并试看")}
              </button>
            )}
            <button type="button" className={errorCode === "RENDER_TRACK_OVERFLOW" ? undefined : "primary"}
              onClick={() => void startPreview(false)}>
              {t("重新试看")}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
