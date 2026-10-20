import type { ReactNode } from "react";
import { speechUnits, type MarketingDraft, type MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { StoryboardEditor } from "./StoryboardEditor.js";
import { Choices, DraftText, type DraftForm } from "./StudioFields.js";

export type SourceKind = "text" | "video" | "upload";

/** Step 1: write copy from a topic, or rewrite a reference video, link or text. */
export function CopyStep({ form, inputId, sourceKind, uploading, analysisPanel, analysis, planError, onSourceKind, onReferenceFile, onStoryboard, onStoryboardAi, onPublication }: {
  form: DraftForm; inputId: string; sourceKind: SourceKind; uploading: boolean;
  /** The copy button, or the reference analysis panel that ends with it. */
  analysisPanel: ReactNode;
  /** Structure notes returned with the latest copy. */
  analysis: string;
  planError: string;
  onSourceKind(kind: SourceKind): void; onReferenceFile(file: File): void;
  onStoryboard(shots: MarketingShot[]): void; onStoryboardAi(instruction: string, index?: number): void; onPublication(): void;
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
            {(["video", "text", "upload"] as const).map(kind => <label key={kind} className={sourceKind === kind ? "selected" : ""}>
              <input type="checkbox" checked={sourceKind === kind} disabled={busy || frozen || !ready} onChange={() => onSourceKind(kind)} />
              {t(kind === "video" ? "视频链接" : kind === "text" ? "文字文案" : "上传本地爆款视频")}
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
          <p className="mv-hint">{t("本地爆款视频支持 MP4、MOV、WebM，最大 100 MB，最长 180 秒，最高 1080p。")}</p>
        </div> : <textarea id={inputId} value={draft.reference} rows={4} maxLength={6000} disabled={busy || frozen || !ready} onChange={e => field("reference", e.target.value)} />}
      </div>
      <p className="mv-hint">{t(sourceKind === "upload" ? "上传后点击一键拆解并生成，AI 读取视频画面、字幕和台词，生成文案与分镜。原视频私有保存 7 天。" : "粘贴视频链接、分享文本或文案，AI 自动拆解并生成文案和分镜。")}</p>
      <p className="mv-hint">{t("拆解素材用于参考文案和结构，不会自动用于视频生成；需要画面参考时，请在“确定素材”中添加。")}</p>
      <details className="mv-creative-brief" open><summary>{t("补充产品与创作要求（选填）")}</summary><DraftText form={form} name="topic" label="产品、卖点和目标顾客" max={800} /></details>
    </> : <DraftText form={form} name="topic" label="产品、卖点和目标顾客" max={800} />}
    <label className="mv-field"><span>{t("整片时长（秒）")} · {draft.durationSec}s</span><input type="range" min="15" max="60" step="1" aria-label={t("整片时长（秒）")} value={draft.durationSec} disabled={busy} onChange={e => field("durationSec", Number(e.target.value))} /></label>
    <p className="mv-hint">{t("选择 15–60 秒目标时长，AI 自动安排每镜 4–15 秒，可多出最多 5 秒，成片最长 65 秒。")}</p>
    {analysisPanel}
    {analysis && <details className="mv-script-review"><summary>{t("文案结构")}</summary><p>{analysis}</p></details>}
    {(draft.copyMode !== "rewrite" || !!draft.script.trim()) && <>
      <DraftText form={form} name="script" label="视频口播文案" max={2000} rows={6} />
      <p className="mv-hint">{t("预计口播 {0} 秒，实际以成片为准。", [Math.ceil(speechUnits(draft.script) / 4)])}</p>
      {!!draft.storyboard.length && <StoryboardEditor creation shots={draft.storyboard} busy={busy} onChange={onStoryboard} onAi={onStoryboardAi} />}
      {draft.script.trim() && planError && <p className="mv-error" role="alert">{t(planError)}</p>}
      <details className="mv-script-review" open><summary>{t("标题标签")}</summary>
        <DraftText form={form} name="publishTitle" label="视频发布标题" max={100} />
        <DraftText form={form} name="tags" label="短视频检索标签" max={160} />
        <button disabled={busy || !ready || !draft.script.trim()} onClick={onPublication}>{t("重新生成标题和标签")}</button>
      </details>
    </>}
  </>;
}
