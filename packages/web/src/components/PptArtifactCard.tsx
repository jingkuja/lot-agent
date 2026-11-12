import { useRef, useState } from "react";
import { encodePptApproval, type PptArtifact, type PptThemeId } from "@lot-agent/core/presentation";
import { useI18n } from "../i18n/index.js";
import { useFileLinks } from "../hooks/useFileLinks.js";
import type { DownloadArtifact } from "../lib/download-artifact.js";
import { FileLink } from "./FileLink.js";
import { OutlineCard } from "./OutlineCard.js";
import { PptThemePicker } from "./PptThemePicker.js";

interface PptArtifactCardProps {
  artifact: PptArtifact;
  download: DownloadArtifact;
  onReply?: (text: string) => void | Promise<void>;
}

export function PptArtifactCard({ artifact, download, onReply }: PptArtifactCardProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [exportError, setExportError] = useState(false);
  const exporting = useRef(false);
  const { deck } = artifact;
  const count = deck.slides.length;
  const uploadedDesign = !!(deck.templateAssetId || deck.backgrounds?.length);
  const previews = useFileLinks(artifact.previewUrls ?? []);
  const changeTheme = async (themePreset: PptThemeId) => {
    if (!onReply || exporting.current) return;
    exporting.current = true;
    setPending(true);
    setExportError(false);
    try {
      await onReply(encodePptApproval({ ...deck, themePreset, templateAssetId: undefined, backgrounds: undefined }));
    } catch {
      setExportError(true);
    } finally {
      exporting.current = false;
      setPending(false);
    }
  };
  return <div className="ppt-artifact-card">
    <div className="doc-download-card">
      <span className="doc-download-icon" aria-hidden>▤</span>
      <span className="doc-download-name">{deck.title} · {t(count === 1 ? "1 页" : "{0} 页", [count])}</span>
      <FileLink className="gen-asset-download" url={download.url} download={`${artifact.deck.title}.pptx`} target="_blank" rel="noreferrer">
        {t("下载")}
      </FileLink>
    </div>
    {!!artifact.previewUrls?.length && previews.ready && <div className="ppt-preview-grid">
      {artifact.previewUrls.map((url, i) => <a key={url} href={previews.link(url)} target="_blank" rel="noreferrer" title={artifact.deck.slides[i]?.title}>
        <img src={previews.link(url)} loading="lazy" alt={`${i + 1}. ${artifact.deck.slides[i]?.title ?? ""}`} />
        <span>{i + 1}. {artifact.deck.slides[i]?.title}</span>
      </a>)}
    </div>}
    {!artifact.previewUrls?.length && <p className="outline-hint">{t("缩略图暂不可用，仍可下载或逐页修改。")}</p>}
    {artifact.warnings.length > 0 && <ul className="ppt-warnings">{artifact.warnings.map((warning, i) => <li key={i}>{warning.message}</li>)}</ul>}
    {!editing && <>
      <PptThemePicker reexport value={uploadedDesign ? undefined : deck.themePreset ?? "business"} onSelect={onReply && !pending ? changeTheme : undefined} />
      {uploadedDesign && <p className="outline-hint">{t("选择内置主题后，重新导出的文件将使用该主题替代上传的模板或背景。")}</p>}
      {pending && <p className="outline-hint" role="status">{t("正在导出…")}</p>}
      {exportError && <p className="ppt-validation" role="alert">{t("导出失败，请重试。")}</p>}
    </>}
    <button className="ppt-edit-toggle" type="button" onClick={() => setEditing(!editing)} aria-expanded={editing} disabled={pending}>
      {t(editing ? "收起编辑" : "逐页查看与修改")}
    </button>
    {editing && <OutlineCard input={deck} interactive={!!onReply} onReply={onReply} exportAgain previewUrls={artifact.previewUrls} />}
  </div>;
}
