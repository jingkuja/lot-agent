import { useEffect, useRef, useState } from "react";
import { knowledgeApi, type Material } from "./api.js";

export function MaterialThumbnail({ material, onClick }: { material: Material; onClick: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const { id, mime, original_name: name } = material;
  useEffect(() => {
    if (!mime.startsWith("image/")) return;
    let stopped = false;
    let objectUrl = "";
    setUrl(""); setFailed(false);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void knowledgeApi.materialFile({ id, mime, original_name: name }).then((file) => {
        if (stopped) return;
        objectUrl = URL.createObjectURL(file); setUrl(objectUrl);
      }).catch(() => { if (!stopped) setFailed(true); });
    }, { rootMargin: "200px" });
    if (button.current) observer.observe(button.current);
    return () => { stopped = true; observer.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, mime, name]);
  return <button ref={button} type="button" className="knowledge-material-thumbnail" onClick={onClick} aria-label={`预览 ${name ?? "素材"}`}>
    {url && !failed ? <img src={url} alt={name ?? "素材缩略图"} onError={() => setFailed(true)} /> :
      <span>{mime.startsWith("image/") ? (failed ? "图片加载失败，点击重试" : "正在加载图片…") : mime.startsWith("video/") ? "▷ 视频" : mime.startsWith("audio/") ? "♫ 音频" : "▤ 文件"}</span>}
  </button>;
}
