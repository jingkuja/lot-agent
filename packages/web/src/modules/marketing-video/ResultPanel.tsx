import type { ReactNode } from "react";
import type { MarketingProject, MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { StoryboardEditor } from "./StoryboardEditor.js";
import { ShotRevision } from "./ShotRevision.js";
import { TaskStatus } from "./TaskStatus.js";
import { DraftText, type DraftForm } from "./StudioFields.js";

/** A submitted video: progress or result, publication copy, and the storyboard it used. */
export function ResultPanel({ form, project, saving, dirty, knowledge, notice, reviewPanel, onCopyDraft, onResume, onCancel, onRelease, onPublication, onCopyText, onArchive, onShots, onRevertShots, onRevise }: {
  form: DraftForm; project: MarketingProject; saving: boolean; dirty: boolean; knowledge: boolean; notice: string;
  /** The text check, shown with the shots to redo. */
  reviewPanel: ReactNode;
  /** Copy into a new draft opened at the given step. */
  onCopyDraft(step: number): void;
  onResume(): void; onCancel(): void; onRelease(): void; onPublication(): void; onCopyText(): void; onArchive(): void;
  onShots(shots: MarketingShot[]): void; onRevertShots(): void; onRevise(shots: number[]): void;
}) {
  const { t } = useI18n();
  const { draft, busy } = form;
  const result = project.status === "succeeded" ? project.output?.assets?.[0] : undefined;
  const archived = project.knowledgeItemId ? project.knowledgeVersion === project.version && !dirty ? "已存入知识库" : "更新知识库草稿" : "存草稿到知识库";
  return <section className="mv-card mv-results">
    <div className="mv-section-head"><h2>{t("生成结果")}</h2><button disabled={busy || saving} onClick={() => onCopyDraft(0)}>{t("复制为新草稿")}</button></div>
    {result
      ? <><video className="mv-result-video" controls src={result.url} /><a className="mv-download" href={result.url} download>{t("下载视频")}</a></>
      : <TaskStatus project={project} busy={busy} onResume={onResume} onCancel={onCancel} onCopy={onCopyDraft} onRelease={onRelease} />}
    <div className="mv-publication">
      <button disabled={busy} onClick={onPublication}>{t("重新生成标题和标签")}</button>
      <DraftText form={form} name="publishTitle" label="视频发布标题" max={100} />
      <DraftText form={form} name="tags" label="短视频检索标签" max={160} />
      <div className="mv-choices">
        <button disabled={busy} onClick={onCopyText}>{t("复制发布文案")}</button>
        <button disabled={busy || project.status !== "succeeded" || !knowledge} onClick={onArchive}>{t(archived)}</button>
      </div>
      {notice && <p className="mv-hint" role="status">{t(notice)}</p>}
      <p className="mv-hint">{t("抖音发布权限尚未接入，请下载视频并复制文案发布。")}</p>
      {!knowledge && <p className="mv-hint">{t("知识库尚未启用。")}</p>}
    </div>
    <details className="mv-script-review" open><summary>{t(project.revision ? "分镜与单镜重做" : "查看制作分镜")}</summary>
      {draft.continuity && <p className="mv-hint">{t("统一人物与场景设定")}：{draft.continuity}</p>}
      {project.revision ? <ShotRevision key={project.taskId} project={project} revision={project.revision} draft={draft} busy={busy} saving={saving} reviewPanel={reviewPanel}
          onChange={onShots} onRevert={onRevertShots} onRevise={onRevise} />
        : draft.storyboard.length ? <StoryboardEditor shots={draft.storyboard} busy={busy} readOnly /> : <p className="mv-hint">{t("旧视频未保存详细分镜，可复制草稿补充分镜后重新制作。")}</p>}
      <button disabled={busy || saving} onClick={() => onCopyDraft(2)}>{t(project.revision ? "复制为新草稿修改其他设置" : "修改分镜并重新制作")}</button>
    </details>
  </section>;
}
