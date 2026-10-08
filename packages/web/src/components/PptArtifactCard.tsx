import { useState } from "react";
import type { PptArtifact } from "@lot-agent/core/presentation";
import { useI18n } from "../i18n/index.js";
import type { DownloadArtifact } from "../lib/download-artifact.js";
import { OutlineCard } from "./OutlineCard.js";

export function PptArtifactCard({ artifact, download, onReply }: { artifact: PptArtifact; download: DownloadArtifact; onReply?: (text: string) => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  return <div className="ppt-artifact-card">
    <div className="doc-download-card">
      <span className="doc-download-icon" aria-hidden>▤</span>
      <span className="doc-download-name">{artifact.deck.title} · {artifact.deck.slides.length} {t("页")}</span>
      <a className="gen-asset-download" href={download.url} download={`${artifact.deck.title}.pptx`} target="_blank" rel="noreferrer">{t("下载")}</a>
    </div>
    {!!artifact.previewUrls?.length && <div className="ppt-preview-grid">{artifact.previewUrls.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer" title={artifact.deck.slides[i]?.title}>
      <img src={url} loading="lazy" alt={`${i + 1}. ${artifact.deck.slides[i]?.title ?? ""}`} /><span>{i + 1}. {artifact.deck.slides[i]?.title}</span>
    </a>)}</div>}
    {!artifact.previewUrls?.length && <p className="outline-hint">{t("缩略图暂不可用，仍可下载或逐页修改。")}</p>}
    {artifact.warnings.length > 0 && <ul className="ppt-warnings">{artifact.warnings.map((warning, i) => <li key={i}>{warning.message}</li>)}</ul>}
    <button className="ppt-edit-toggle" type="button" onClick={() => setEditing(!editing)} aria-expanded={editing}>{t(editing ? "收起编辑" : "逐页查看与修改")}</button>
    {editing && <OutlineCard input={artifact.deck} interactive={!!onReply} onReply={onReply} exportAgain previewUrls={artifact.previewUrls} />}
  </div>;
}
