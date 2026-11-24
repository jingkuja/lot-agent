import { useEffect, useRef, useState } from "react";
import type { ComicImageTake } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicGenerationApi } from "./generation-api.js";
import { comicGenerationError } from "./GenerationQuoteDialog.js";

const labels: Record<ComicImageTake["state"], string> = {
  pending: "等待生成", running: "正在生成", ready: "图片已入库",
  failed: "生成失败", recoverable: "可恢复处理", unknown: "提交结果待核实",
  cancelled: "已取消", released: "已释放旧提交",
};
export function ComicTakeStatus({ take }: { take: ComicImageTake }) {
  const { t } = useI18n();
  const video = take.mode !== null && take.mode !== "keyframe";
  const label = take.error === "REAL_PERSON_REJECTED" ? "模型拒绝了真人参考图"
    : take.error === "VIDEO_GATEWAY_FAILED" ? "网关返回错误，可查看回执"
    : take.error === "VIDEO_DOWNLOAD_REQUIRED" ? "视频已生成，待下载"
    : take.creditCheck ? "等待积分检查" : video && take.state === "ready" ? "视频已入库"
    : take.state === "running" && take.cancelRequested ? "正在停止处理" : labels[take.state];
  return <span className="comic-take-status" data-state={take.state}>
    {t(label)}{video && take.state === "running" && !take.cancelRequested ? ` · ${take.progress}%` : ""}
  </span>;
}

export function useGenerationHistory<T>(load: (signal: AbortSignal) => Promise<T>, interval = 5_000, revision = 0) {
  const [current, setCurrent] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const data = await load(controller.signal);
        if (!controller.signal.aborted) { setCurrent(data); setFailed(false); }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, interval);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [attempt, interval, load, revision]);
  return { current, failed, refresh: () => setAttempt(attempt => attempt + 1) };
}

export function RecoverComicImage({ take, refreshed }: { take: ComicImageTake; refreshed: () => void }) {
  const { t } = useI18n();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recover = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await comicGenerationApi.recover(take.requestId);
      refreshed();
    } catch (reason) { setError(comicGenerationError(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <>
    <button type="button" disabled={busy} onClick={() => void recover()}>{t(busy ? "提交中…" : "恢复原任务")}</button>
    {error && <span className="comic-error" role="alert">{t(error)}</span>}
  </>;
}

export function ImageTakeActions({ take, refreshed }: { take: ComicImageTake; refreshed: () => void }) {
  const { t } = useI18n();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: "recover" | "cancel" | "release") => {
    if (pending.current) return;
    if (action === "release" && !window.confirm(t("原请求可能已扣费。释放后可重新报价，新请求可能再次扣费。确认释放？"))) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "recover") await comicGenerationApi.recover(take.requestId);
      else await comicGenerationApi.imageAction(take.id, action);
      refreshed();
    } catch (reason) { setError(comicGenerationError(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  const canCancel = (take.state === "pending" || take.state === "running" || take.state === "recoverable") && !take.cancelRequested;
  const canRecover = take.state === "recoverable";
  const canRelease = take.state === "unknown";
  if (!canCancel && !canRecover && !canRelease) return null;
  return <>
    <div className="comic-actions">
      {canRecover && <button type="button" disabled={busy} onClick={() => void run("recover")}>{t(busy ? "提交中…" : "恢复原任务")}</button>}
      {canCancel && <button type="button" disabled={busy} onClick={() => void run("cancel")}>{t("停止此项")}</button>}
      {canRelease && <button type="button" disabled={busy} onClick={() => void run("release")}>{t("释放旧提交")}</button>}
    </div>
    {error && <span className="comic-error" role="alert">{t(error)}</span>}
  </>;
}
