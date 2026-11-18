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
  const video = take.mode === "references" || take.mode === "from_keyframe";
  const label = take.error === "REAL_PERSON_REJECTED" ? "模型拒绝了真人参考图"
    : take.error === "VIDEO_GATEWAY_FAILED" ? "网关返回错误，可查看回执"
    : take.error === "VIDEO_DOWNLOAD_REQUIRED" ? "视频已生成，待下载"
    : video && take.state === "ready" ? "视频已入库"
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
