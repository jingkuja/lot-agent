import type { ReactNode } from "react";
import { marketingMaxDuration, marketingSpeechEstimate, type MarketingDraft } from "@lot-agent/core/marketing-video";
import { analysisUploadRule } from "./materials.js";
import { useI18n } from "../../i18n/index.js";
import { ShotOverview } from "./StoryboardEditor.js";
import { Choices, DraftText, type DraftForm } from "./StudioFields.js";

export type SourceKind = "text" | "video" | "upload";

const SOURCE_HINTS: Record<SourceKind, string> = {
  upload: "上传后点击一键拆解并生成，AI 读取视频画面、字幕和台词，生成文案与分镜。原视频私有保存 7 天。",
  video: "已识别为视频链接，AI 读取视频画面、字幕和台词，生成文案与分镜。",
  text: "已识别为参考文案，AI 按其结构改写文案与分镜。",
};

/** Step 1: write copy from a topic, or rewrite a reference video, link or text. The shots it plans are
 * listed here and edited in the confirmation step. */
export function CopyStep({ form, inputId, sourceKind, uploading, analysisPanel, analysis, planError, history, onUploadSource, onReferenceFile,
  onPublication }: {
  form: DraftForm; inputId: string; sourceKind: SourceKind; uploading: boolean;
  /** The copy button, or the reference analysis panel that ends with it. */
  analysisPanel: ReactNode;
  /** Structure notes returned with the latest copy. */
  analysis: string;
  planError: string;
  /** Earlier copy and storyboard versions to restore. */
  history: ReactNode;
  /** Links and pasted copy are told apart automatically; only uploads are chosen. */
  onUploadSource(upload: boolean): void; onReferenceFile(file: File): void; onPublication(): void;
}) {
  const { t } = useI18n();
  const { draft, busy, frozen, ready, field } = form;
  return <>
    <Choices form={form} label="文案方式" values={[{ value: "generate", label: "智能生成文案" }, { value: "rewrite", label: "拆解爆款文案" }]} value={draft.copyMode} onChoose={value => field("copyMode", value as MarketingDraft["copyMode"])} />
    {draft.copyMode === "rewrite" ? <>
      <div className="mv-reference-input">
        <div className="mv-reference-heading">
          <label htmlFor={inputId}>{t("视频链接或参考文案")}</label>
          <div className="mv-source-options" role="group" aria-label={t("参考内容类型")}>
            {[false, true].map(upload => <label key={String(upload)} className={(sourceKind === "upload") === upload ? "selected" : ""}>
              <input type="radio" name={`${inputId}-source`} checked={(sourceKind === "upload") === upload} disabled={busy || frozen || !ready} onChange={() => onUploadSource(upload)} />
              {t(upload ? "上传本地爆款视频" : "粘贴链接或文案")}
            </label>)}
          </div>
        </div>
        {sourceKind === "upload" ? <div className="mv-upload">
          <label className="mv-upload-button">{t(uploading ? "正在上传本地视频…" : draft.referenceUpload ? "替换本地爆款视频" : "选择本地视频文件")}
            <input type="file" accept="video/mp4,video/quicktime,video/webm" aria-label={t("选择本地视频文件")} disabled={busy || frozen || !ready} onChange={e => {
              const file = e.target.files?.[0]; e.target.value = "";
              if (file) onReferenceFile(file);
            }} />
          </label>
          {draft.referenceUpload && <div className="mv-local-reference"><span>{draft.referenceUpload.name}</span><button type="button" disabled={busy || frozen || !ready} onClick={() => field("referenceUpload", undefined)}>{t("移除")}</button></div>}
          <p className="mv-hint">{t(analysisUploadRule())}</p>
        </div> : <textarea id={inputId} value={draft.reference} rows={4} maxLength={6000} disabled={busy || frozen || !ready} onChange={e => field("reference", e.target.value)} />}
      </div>
      <p className="mv-hint">{t(sourceKind !== "upload" && !draft.reference.trim() ? "粘贴视频链接、分享文本或文案，AI 自动识别并生成文案和分镜。" : SOURCE_HINTS[sourceKind])}</p>
      <details className="mv-creative-brief" open><summary>{t("补充产品与创作要求（选填）")}</summary><DraftText form={form} name="topic" label="产品、卖点和目标顾客" max={800} /></details>
    </> : <DraftText form={form} name="topic" label="产品、卖点和目标顾客" max={800} />}
    <label className="mv-field"><span>{t("整片时长（秒）")} · {draft.durationSec}s</span><input type="range" min="15" max="60" step="1" aria-label={t("整片时长（秒）")} value={draft.durationSec} disabled={busy} onChange={e => field("durationSec", Number(e.target.value))} /></label>
    <label className="mv-label">{t("出镜人物")}</label>
    <Choices form={form} label="出镜人物" values={[{ value: "mixed", label: "按分镜安排" }, { value: "always", label: "全程出镜" }]} value={draft.presenter}
      onChoose={value => field("presenter", value as MarketingDraft["presenter"])} />
    <p className="mv-hint">{t(draft.presenter === "mixed"
      ? "人物是否出镜、景别和构图按文案分镜安排，可穿插环境、菜品、产品和手部特写。"
      : "每个镜头都有出镜人物正面出镜，适合口播宣传。")}</p>
    {analysisPanel}
    {analysis && <details className="mv-script-review"><summary>{t("文案结构")}</summary><p>{analysis}</p></details>}
    {(draft.copyMode !== "rewrite" || !!draft.script.trim()) && <>
      <DraftText form={form} name="script" label="视频口播文案" max={2000} rows={6} />
      <p className="mv-hint">{t("预计口播 {0} 秒，{1} 秒视频最长可到 {2} 秒，实际以成片为准。", [
        marketingSpeechEstimate(draft.script), draft.durationSec, marketingMaxDuration(draft.durationSec)])}</p>
      {!!draft.storyboard.length && <div className="mv-storyboard-panel">
        <div className="mv-section-head"><h3>{t("分镜总览")}</h3>
          <span>{t("{0} 个分镜 · 共 {1} 秒", [draft.storyboard.length, draft.storyboard.reduce((sum, shot) => sum + (shot.durationSec ?? 15), 0)])}</span></div>
        <ShotOverview shots={draft.storyboard} />
        <p className="mv-hint">{t("分镜和统一设定在「确认与生成」中修改。")}</p>
      </div>}
      {draft.script.trim() && planError && <p className="mv-error" role="alert">{t(planError)}</p>}
      {history}
      <details className="mv-script-review" open><summary>{t("标题标签")}</summary>
        <DraftText form={form} name="publishTitle" label="视频发布标题" max={100} />
        <DraftText form={form} name="tags" label="短视频检索标签" max={160} />
        <button disabled={busy || !ready || !draft.script.trim()} onClick={onPublication}>{t("重新生成标题和标签")}</button>
      </details>
    </>}
  </>;
}
