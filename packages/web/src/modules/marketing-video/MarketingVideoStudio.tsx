import { useState, type ReactNode } from "react";
import type { PickedFile, VideoPublication } from "../../api/client.js";
import type { VideoSettings } from "../../components/MediaSettings.js";
import { useI18n } from "../../i18n/index.js";
import { ProjectStudio } from "./ProjectStudio.js";
import "./marketing-video.css";

interface Props {
  ownerId?: string;
  onSubmit: (content: string, files: PickedFile[], settings: VideoSettings, publication: VideoPublication) => void | Promise<void>;
  onDraftChange?: (dirty: boolean) => void;
  onNewVideo?: () => void;
  busy: boolean;
  hasMessages: boolean;
  publication?: unknown;
  children: ReactNode;
}

/** Existing conversation results remain readable; new work uses durable projects. */
export function MarketingVideoStudio({ ownerId, onDraftChange, onNewVideo, busy, hasMessages, publication, children }: Props) {
  const { t } = useI18n();
  const [notice, setNotice] = useState("");
  if (!hasMessages) return <ProjectStudio ownerId={ownerId} onDraftChange={onDraftChange} />;
  const saved = publication && typeof publication === "object" ? publication as Partial<VideoPublication> : null;
  const copy = [saved?.copy, saved?.tags].filter(value => typeof value === "string").join("\n");
  return <div className="mv-scroll"><div className="mv-studio"><section className="mv-card mv-results">
    <div className="mv-section-head"><h2>{t("生成结果")}</h2><button disabled={busy} onClick={onNewVideo}>{t("开始新视频")}</button></div>
    {children}
    {copy && <div className="mv-publication"><h3>{t("发布文案")}</h3><p>{copy}</p><button onClick={() => void navigator.clipboard.writeText(copy).then(() => setNotice("已复制"), () => setNotice("复制失败，请选中文字手动复制。"))}>{t("复制发布文案")}</button><span role="status">{t(notice)}</span></div>}
  </section></div></div>;
}
