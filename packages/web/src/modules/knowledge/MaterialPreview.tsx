import { PreviewDialog } from "./PreviewDialog.js";
import { useEffect, useState } from "react";
import { knowledgeApi, type Material } from "./api.js";
/** Authenticated original preview; never puts a bearer token into a URL. */
export function MaterialPreview({ material, onClose }: { material: Material; onClose: () => void }) {
  const [url, setUrl] = useState(""); const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false; let objectUrl = ""; setUrl(""); setError("");
    void knowledgeApi.materialFile(material).then((file) => {
      if (stopped) return; objectUrl = URL.createObjectURL(file); setUrl(objectUrl);
    }).catch(() => { if (!stopped) setError("原件不可用，请刷新后重试。"); });
    return () => { stopped = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [material]);
  return <PreviewDialog onClose={onClose}><section className="knowledge-preview" aria-label="素材原件"><div className="knowledge-head"><h3>{material.original_name ?? "素材预览"}</h3><button onClick={onClose} autoFocus aria-label="关闭预览">关闭 ×</button></div>
    {error ? <p role="alert">{error}</p> : !url ? <p role="status">正在载入原件…</p> : <>
      {material.mime.startsWith("image/") && <img src={url} alt={material.original_name ?? "素材"} />}
      {material.mime.startsWith("audio/") && <audio src={url} controls />}{material.mime.startsWith("video/") && <video src={url} controls />}
      <a href={url} download={material.original_name ?? "素材"}>下载原件</a>
    </>}
  </section></PreviewDialog>;
}
