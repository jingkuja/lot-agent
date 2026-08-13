import { useState } from "react";
import { api } from "../api/client.js";
import type { GenerationView } from "../hooks/useChat.js";

const LABELS = {
  image: { loading: "图片生成中……", fail: "图片生成失败", cancelled: "图片生成已取消", downloadFail: "图片下载失败" },
  video: { loading: "视频生成中……", fail: "视频生成失败", cancelled: "视频生成已取消", downloadFail: "视频下载失败" },
};

type Asset = { url: string; mime: string; durationSec?: number };

function DownloadLink({ href, name }: { href: string; name: string }) {
  return (
    <a className="gen-asset-download" href={href} download={name} target="_blank" rel="noreferrer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12" />
        <path d="m7 11 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      下载
    </a>
  );
}

/** One generated asset: preview (img/video) + download link, with a graceful
    fallback so a load error never looks like a bare broken-image icon. */
function AssetView({ asset, mediaType, index }: { asset: Asset; mediaType: "image" | "video"; index: number }) {
  const [errored, setErrored] = useState(false);
  const ext = (asset.url.split("?")[0].split(".").pop() || "bin").toLowerCase();
  const name = `生成结果${index + 1}.${ext}`;
  const isVideo = mediaType === "video" && asset.mime.startsWith("video/");

  return (
    <div className="gen-asset-item">
      {isVideo ? (
        <video className="gen-asset" src={asset.url} controls />
      ) : errored ? (
        <div className="gen-asset-fallback" title={asset.url}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2.5" />
            <circle cx="8.5" cy="8.5" r="1.6" />
            <path d="m21 15-4.5-4.5L5 21" />
          </svg>
          <span>结果文件（无法预览）</span>
        </div>
      ) : (
        <img className="gen-asset" src={asset.url} alt={name} onError={() => setErrored(true)} />
      )}
      <DownloadLink href={asset.url} name={name} />
    </div>
  );
}

function MediaIcon({ mediaType }: { mediaType: "image" | "video" }) {
  if (mediaType === "video") {
    return (
      <svg viewBox="0 0 24 24" className="gen-card-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
        <path d="M10 9.5v5l4-2.5z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="gen-card-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="m21 15-4.5-4.5L5 21" />
    </svg>
  );
}

export function GenerationCard({
  generation,
  messageId,
  onRedownload,
}: {
  generation: GenerationView;
  messageId?: string;
  /** Retry only the download of a "下载失败" generation (vendor media already
   * succeeded). Undefined disables the re-download button. */
  onRedownload?: (messageId: string, mediaType: "image" | "video") => void;
}) {
  const { mediaType, status, assets, error, taskId } = generation;
  const [cancelRequested, setCancelRequested] = useState(false);

  if (status === "completed" && assets && assets.length > 0) {
    return (
      <div className="gen-card-assets">
        {assets.map((a, i) => (
          <AssetView key={i} asset={a} mediaType={mediaType} index={i} />
        ))}
      </div>
    );
  }

  const cancelled = status === "cancelled";
  // The vendor produced the media but our download of it failed — recoverable,
  // shown distinctly from a real generation failure and offering a retry.
  const downloadFailed = status === "download_failed";
  const failed = status === "failed" || status === "completed";
  const generating = !failed && !cancelled && !downloadFailed;
  const label = cancelled
    ? LABELS[mediaType].cancelled
    : downloadFailed
      ? LABELS[mediaType].downloadFail
      : failed
        ? LABELS[mediaType].fail
        : generation.supportsProgress
          ? `${mediaType === "video" ? "视频" : "图片"}生成中 ${generation.progress ?? 0}%`
          : LABELS[mediaType].loading;

  // Fire the cancel request; the ongoing task poll observes the terminal
  // 'cancelled' status and finalizes the card, so no local state juggling.
  const onCancel = () => {
    if (!taskId || cancelRequested) return;
    setCancelRequested(true);
    api.cancelTask(taskId).catch(() => setCancelRequested(false));
  };

  return (
    <div className={`gen-card ${mediaType} ${generating ? "gen-card--loading" : "gen-card--failed"}`} title={error ?? undefined}>
      <MediaIcon mediaType={mediaType} />
      <div className="gen-card-label">{label}</div>
      {generating && taskId && (
        <button type="button" className="gen-card-cancel" onClick={onCancel} disabled={cancelRequested}>
          {cancelRequested ? "取消中…" : "取消"}
        </button>
      )}
      {downloadFailed && messageId && onRedownload && (
        <button type="button" className="gen-card-retry" onClick={() => onRedownload(messageId, mediaType)}>
          重新下载
        </button>
      )}
    </div>
  );
}
