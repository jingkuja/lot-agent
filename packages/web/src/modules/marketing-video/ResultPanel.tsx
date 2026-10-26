import type { ReactNode } from "react";
import { marketingCaptionSrt, type MarketingCaption, type MarketingComposition, type MarketingNarrationClip, type MarketingProject, type MarketingQualityReport,
  type MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { StoryboardEditor } from "./StoryboardEditor.js";
import { ShotRevision } from "./ShotRevision.js";
import { TaskStatus } from "./TaskStatus.js";
import { DraftText, MaterialField, type DraftForm, type MaterialHandlers } from "./StudioFields.js";
import { NarrationSettings } from "./ProductionStep.js";
import { CaptionSettings } from "./CaptionSettings.js";

/** Settings only the local composition of a made video uses. Changing them composes the kept
 * clips again, without the video model. */
function CompositionSettings({ form, composition, renderedSubtitles, captions, recompose, handlers, onPickNarrationVoice }: {
  form: DraftForm; composition: MarketingComposition; handlers: MaterialHandlers; onPickNarrationVoice(): void;
  /** Whether the kept clips were made for captions, with the bottom of the frame kept clear. */
  renderedSubtitles: boolean;
  /** Composes the kept clips again; shown beside the caption settings. */
  recompose: ReactNode;
  /** Cues burned into the current video, shown beside each shot's captions. */
  captions?: MarketingCaption[];
}) {
  const { t } = useI18n();
  // The video's other settings stay frozen; the server accepts only these and shot text.
  const open: DraftForm = { ...form, frozen: false };
  const { draft, busy, field } = open;
  return <div className="mv-composition" role="group" aria-label={t("成片设置")}>
    <h3>{t("成片设置")}</h3>
    <p className="mv-hint">{t(composition.localSubtitles ? "修改背景音乐、音量或字幕后，点击「重新合成成片」：沿用全部已生成的片段，不调用视频模型。" : "修改背景音乐或音量后，点击下方「重新合成成片」：沿用全部已生成的片段，不调用视频模型。")}</p>
    {composition.narration && draft.narration && <>
      <NarrationSettings form={open} onPickVoice={onPickNarrationVoice} made />
      <p className="mv-hint">{t("修改旁白音色、语速或语气会重新合成全部配音，按语音合成计费；画面不变。")}</p>
    </>}
    <MaterialField form={open} slot="music" label="选择背景音乐（选填）" handlers={handlers} />
    {draft.assets.music && <label className="mv-field"><span>{t("背景音乐音量")}</span><input aria-label={t("背景音乐音量")} type="range" min="0" max="0.5" step="0.01" value={draft.musicVolume} disabled={busy} onChange={e => field("musicVolume", Number(e.target.value))} /></label>}
    {composition.localSubtitles && <label className="mv-checkbox"><input type="checkbox" checked={draft.subtitles} disabled={busy} onChange={e => field("subtitles", e.target.checked)} />{t("添加字幕")}</label>}
    {composition.localSubtitles && draft.subtitles && !renderedSubtitles && <p className="mv-hint" role="note">{t("这条视频制作时没有开字幕，片段没有为字幕留出底部区域，字幕可能遮挡人脸或产品。重新合成后请检查；遮挡明显的镜头可在下方勾选「重新生成此镜」，按视频模型计费。")}</p>}
    {composition.localSubtitles && draft.subtitles && <CaptionSettings form={open} captions={captions} recompose={recompose} />}
    {!composition.localSubtitles && draft.subtitles && <p className="mv-hint">{t("这条视频的字幕由视频模型画在画面里，不能单独调整；复制为新草稿重新制作后，字幕改为合成时加入，可以调整。")}</p>}
  </div>;
}

const QUALITY_KINDS = { black: "黑屏", freeze: "画面静止", silence: "无声（不含背景音乐）" } as const;
/** Local checks of the made video: black, frozen and silent stretches by shot, length and captions.
 * They do not judge faces or wording, so the video still needs a full watch. */
function QualityReport({ quality, redo }: { quality: MarketingQualityReport; redo: boolean }) {
  const { t } = useI18n();
  return <section className="mv-quality" aria-label={t("成片检查")}>
    <h3>{t("成片检查")}</h3>
    {!quality.checked ? <p className="mv-hint" role="status">{t("本次未能完成成片检查，请完整观看成片。")}</p> : <>
      <p className="mv-hint">{t("成片 {0} 秒，分镜共 {1} 秒。", [quality.durationSec.toFixed(1), quality.expectedSec])}</p>
      {quality.issues.length ? <>
        <ul className="mv-quality-list">{quality.issues.map((issue, i) => <li key={i}>
          <span>{t("第 {0} 镜", [issue.shot + 1])}</span>{t(QUALITY_KINDS[issue.kind])}<small>{issue.start.toFixed(1)}–{issue.end.toFixed(1)}s</small>
        </li>)}</ul>
        {redo && <p className="mv-hint">{t("如有需要，可在下方「修改成片」中只重新生成这些镜头。")}</p>}
      </> : <p className="mv-quality-ok" role="status">{t(quality.speech ? "未发现黑屏、画面静止或超过 2 秒的无声片段。" : "未发现黑屏或画面静止。")}</p>}
    </>}
    <p className="mv-hint">{quality.subtitles === "burned" ? t("字幕按确认文案烧录，共 {0} 条。", [quality.captions ?? 0])
      : t(quality.subtitles === "model" ? "字幕由视频模型绘制，未自动检查，请逐句校对。" : "未添加字幕。")}</p>
    <p className="mv-hint">{t("检查只看黑屏、静止画面、无声和时长，不判断人物是否一致或文字是否正确，发布前请完整观看。")}</p>
  </section>;
}

/** A submitted video: progress or result, publication copy, and the storyboard it used. */
export function ResultPanel({ form, project, saving, dirty, knowledge, notice, reviewPanel, narration, handlers, onPickNarrationVoice, onCopyDraft, onResume,
  onCancel, onRelease, onPublication, onCopyText, onArchive, onShots, onRevertShots, onRevise }: {
  form: DraftForm; project: MarketingProject; saving: boolean; dirty: boolean; knowledge: boolean; notice: string;
  /** Twin narration takes of the saved draft, for redoing shots of a narrated video. */
  narration: MarketingNarrationClip[] | null;
  /** Background music of a made video, composed again without the video model. */
  handlers: MaterialHandlers; onPickNarrationVoice(): void;
  /** The text check, shown with the shots to redo. */
  reviewPanel: ReactNode;
  /** Copy into a new draft opened at the given step. */
  onCopyDraft(step: number): void;
  onResume(): void; onCancel(): void; onRelease(): void; onPublication(): void; onCopyText(): void; onArchive(): void;
  onShots(shots: MarketingShot[]): void; onRevertShots(): void; onRevise(shots: number[], narrationRedo?: number[]): void;
}) {
  const { t } = useI18n();
  const { draft, busy } = form;
  const result = project.status === "succeeded" ? project.output?.assets?.[0] : undefined;
  const continuity = draft.continuity && <p className="mv-hint">{t("统一人物、产品与场景设定")}：{draft.continuity}</p>;
  const archived = project.knowledgeItemId ? project.knowledgeVersion === project.version && !dirty ? "已存入知识库" : "更新知识库草稿" : "存草稿到知识库";
  return <section className="mv-card mv-results">
    <div className="mv-section-head"><h2>{t("生成结果")}</h2><button disabled={busy || saving} onClick={() => onCopyDraft(0)}>{t("复制为新草稿")}</button></div>
    {result
      ? <><video className="mv-result-video" controls src={result.url} />
        <div className="mv-downloads"><a className="mv-download" href={result.url} download>{t("下载视频")}</a>
          {!!project.output?.captions?.length && <a className="mv-download" href={`data:application/x-subrip;charset=utf-8,${encodeURIComponent(marketingCaptionSrt(project.output.captions))}`} download="captions.srt">{t("下载字幕（SRT）")}</a>}</div>
        {project.output?.quality && <QualityReport quality={project.output.quality} redo={!!project.revision} />}</>
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
    <details className="mv-script-review" open><summary>{t(project.revision ? "修改成片" : "查看制作分镜")}</summary>
      {project.revision ? <ShotRevision key={project.taskId} project={project} revision={project.revision} draft={draft} busy={busy} saving={saving} reviewPanel={reviewPanel}
          narration={narration} settings={recompose => <>
            <CompositionSettings form={form} composition={project.revision!.composition} renderedSubtitles={project.revision!.draft.subtitles} captions={project.output?.captions} recompose={recompose} handlers={handlers} onPickNarrationVoice={onPickNarrationVoice} />
            {continuity}
          </>}
          onChange={onShots} onRevert={onRevertShots} onRevise={onRevise} />
        : <>{continuity}{draft.storyboard.length ? <StoryboardEditor shots={draft.storyboard} busy={busy} readOnly /> : <p className="mv-hint">{t("旧视频未保存详细分镜，可复制草稿补充分镜后重新制作。")}</p>}</>}
      <button disabled={busy || saving} onClick={() => onCopyDraft(2)}>{t(project.revision ? "复制为新草稿修改其他设置" : "修改分镜并重新制作")}</button>
    </details>
  </section>;
}
