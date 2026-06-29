import type { GenerationView } from "../hooks/useChat.js";

const LABELS = {
  image: { loading: "图片生成中……", fail: "图片生成失败" },
  video: { loading: "视频生成中……", fail: "视频生成失败" },
};

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

export function GenerationCard({ generation }: { generation: GenerationView }) {
  const { mediaType, status, assets, error } = generation;

  if (status === "completed" && assets && assets.length > 0) {
    return (
      <div className="gen-card-assets">
        {assets.map((a, i) =>
          mediaType === "video" && a.mime.startsWith("video/") ? (
            <video key={i} className="gen-asset" src={a.url} controls />
          ) : (
            <img key={i} className="gen-asset" src={a.url} alt={`生成结果 ${i + 1}`} />
          )
        )}
      </div>
    );
  }

  const failed = status === "failed" || status === "completed";
  return (
    <div className={`gen-card ${mediaType} ${failed ? "gen-card--failed" : "gen-card--loading"}`} title={error ?? undefined}>
      <MediaIcon mediaType={mediaType} />
      <div className="gen-card-label">{failed ? LABELS[mediaType].fail : LABELS[mediaType].loading}</div>
    </div>
  );
}
