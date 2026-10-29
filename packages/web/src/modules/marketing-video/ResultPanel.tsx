import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { marketingCaptionSrt, type MarketingCaption, type MarketingComposition, type MarketingNarrationClip, type MarketingProject,
  type MarketingQualityReport, type MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { StoryboardEditor } from "./StoryboardEditor.js";
import { ShotRevision } from "./ShotRevision.js";
import { TaskStatus } from "./TaskStatus.js";
import { DraftText, MaterialField, type DraftForm, type MaterialHandlers } from "./StudioFields.js";
import { NarrationSettings } from "./ProductionStep.js";
import { CaptionSettings } from "./CaptionSettings.js";
import { CaptionPreviewModes, ResultVideo, type ResultPlayer } from "./CaptionPreview.js";
import { CONFIRM_STEP } from "./production-checks.js";

/** Settings only the local composition of a made video uses. Changing them composes the kept
 * clips again, without the video model. */
function CompositionSettings({ form, composition, renderedSubtitles, captions, recompose, handlers, previewable, previewModes, anchor, onPickNarrationVoice,
  onPlayShot }: {
  form: DraftForm; composition: MarketingComposition; handlers: MaterialHandlers; onPickNarrationVoice(): void;
  /** Whether the kept clips were made for captions, with the bottom of the frame kept clear. */
  renderedSubtitles: boolean;
  /** Composes the kept clips again; shown beside the caption settings. */
  recompose: ReactNode;
  /** Cues burned into the current video, shown beside each shot's captions. */
  captions?: MarketingCaption[];
  /** False for a made video without a caption-free copy: caption changes cannot be watched before composing again. */
  previewable: boolean;
  /** Switches the made video above between itself and the caption preview; absent when it has no preview. */
  previewModes?: ReactNode;
  /** Focused when the user comes back to these settings, after discarding a preview. */
  anchor: RefObject<HTMLDivElement | null>;
  /** Plays one shot of the made video; absent until it is made. */
  onPlayShot?: (index: number) => void;
}) {
  const { t } = useI18n();
  // The video's other settings stay frozen; the server accepts only these and shot text.
  const open: DraftForm = { ...form, frozen: false };
  const { draft, busy, field } = open;
  return <div ref={anchor} className="mv-composition" role="group" aria-label={t("成片设置")} tabIndex={-1}>
    <h3>{t("成片设置")}</h3>
    <p className="mv-hint">{t(composition.localSubtitles ? "修改背景音乐、音量或字幕后，点击「重新合成成片」：沿用全部已生成的片段，不调用视频模型。" : "修改背景音乐或音量后，点击下方「重新合成成片」：沿用全部已生成的片段，不调用视频模型。")}</p>
    {composition.narration && draft.narration && <>
      <NarrationSettings form={open} onPickVoice={onPickNarrationVoice} made />
      <p className="mv-hint">{t("修改旁白音色、语速或语气会重新合成全部配音，会产生费用；画面不变。")}</p>
    </>}
    <MaterialField form={open} slot="music" label="选择背景音乐（选填）" handlers={handlers} />
    {draft.assets.music && <label className="mv-field"><span>{t("背景音乐音量")}</span><input aria-label={t("背景音乐音量")} type="range" min="0" max="0.5" step="0.01" value={draft.musicVolume} disabled={busy} onChange={e => field("musicVolume", Number(e.target.value))} /></label>}
    {composition.localSubtitles && <label className="mv-checkbox"><input type="checkbox" checked={draft.subtitles} disabled={busy} onChange={e => field("subtitles", e.target.checked)} />{t("添加字幕")}</label>}
    {composition.localSubtitles && previewModes}
    {composition.localSubtitles && draft.subtitles && !renderedSubtitles && <p className="mv-hint" role="note">{t("这条视频制作时没有开字幕，片段没有为字幕留出底部区域，字幕可能遮挡人脸或产品。重新合成后请检查；遮挡明显的镜头可在下方勾选「重新生成此镜」，会产生费用。")}</p>}
    {composition.localSubtitles && draft.subtitles && !previewable && <p className="mv-hint" role="note">
      {t("这条视频合成时没有保留无字幕版本，修改字幕后不能实时预览；重新合成成片后，再修改字幕即可实时预览。")}</p>}
    {composition.localSubtitles && draft.subtitles && <CaptionSettings form={open} captions={captions} recompose={recompose} onPlayShot={onPlayShot} />}
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
  onCancel, onRelease, onPublication, onCopyText, onArchive, onShots, onRevertShots, onRevise, onSettlePreview }: {
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
  onShots(shots: MarketingShot[]): void; onRevertShots(): void; onRevise(shots: number[], narrationRedo?: number[], preview?: boolean): void;
  /** Keeps a made preview in place of the video it previews, or discards it. */
  onSettlePreview(action: "keep" | "discard"): Promise<void>;
}) {
  const { t } = useI18n();
  const { draft, busy } = form;
  const section = useRef<HTMLElement>(null);
  const result = project.status === "succeeded" ? project.output?.assets?.[0] : undefined;
  const player = useRef<ResultPlayer>(null);
  const previewable = !!result && !!project.output?.preview && !!project.output.captionTiming?.length;
  // The caption preview is chosen per made video; a new one starts on the video itself.
  const resultKey = result && `${project.taskId}:${result.url}`;
  const [previewed, setPreviewed] = useState<string>();
  const previewing = !!resultKey && previewed === resultKey;
  const onPreview = (next: boolean) => setPreviewed(next ? resultKey : undefined);
  /** Choosing the caption preview composes a preview video beside the made one; its progress shows at the top of the
   * results. When it cannot be composed now, or paid takes were declined, the captions are drawn over the video instead. */
  const choosePreview = async (next: boolean, composePreview?: () => Promise<boolean>) => {
    if (!next || !composePreview) { player.current?.showPreview(next); return; }
    if (!await composePreview()) { player.current?.showPreview(true, false); return; }
    // The preview video draws its own captions; it starts without the overlay.
    setPreviewed(undefined);
    section.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    section.current?.focus({ preventScroll: true });
  };
  const base = project.previewBase;
  const settings = useRef<HTMLDivElement>(null);
  // After a discard the made video is current again; the user goes back to the settings the preview tried.
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    if (base || !settings.current) return;
    settings.current.scrollIntoView({ block: "start", behavior: "smooth" });
    settings.current.focus({ preventScroll: true });
  }, [refocus, base]);
  const discard = async () => { await onSettlePreview("discard"); setRefocus(true); };
  const settleBusy = busy || saving;
  const continuity = draft.continuity && <p className="mv-hint">{t("统一人物、产品与场景设定")}：{draft.continuity}</p>;
  const archived = project.knowledgeItemId ? project.knowledgeVersion === project.version && !dirty ? "已存入知识库" : "更新知识库中的视频" : "保存视频到知识库";
  return <section ref={section} className="mv-card mv-results" tabIndex={-1}>
    <div className="mv-section-head"><h2>{t("生成结果")}</h2><button disabled={busy || saving} onClick={() => onCopyDraft(0)}>{t("复制为新草稿")}</button></div>
    {result
      ? <><ResultVideo key={resultKey} url={result.url} output={project.output!} draft={draft} player={player} previewing={previewing} onPreview={onPreview}
          rendered={project.revision?.composition.localSubtitles ? project.revision.draft : undefined} />
        {base && <div className="mv-preview-decision" role="group" aria-label={t("预览成片")}>
          <p className="mv-hint">{t("这是预览成片，原成片仍保留。替换后删除原成片；放弃则删除这条预览成片。")}</p>
          <div className="mv-choices">
            <button className="mv-primary" disabled={settleBusy} onClick={() => void onSettlePreview("keep")}>{t("替换原成片")}</button>
            <button disabled={settleBusy} onClick={() => void discard()}>{t("放弃预览")}</button>
          </div>
          <details><summary>{t("对比原成片")}</summary>
            <video key={base.taskId} className="mv-result-video" controls preload="metadata" src={base.url} /></details>
        </div>}
        <div className="mv-downloads"><a className="mv-download" href={result.url} download>{t("下载视频")}</a>
          {!!project.output?.captions?.length && <a className="mv-download" download="captions.srt"
            href={`data:application/x-subrip;charset=utf-8,${encodeURIComponent(marketingCaptionSrt(project.output.captions))}`}>{t("下载字幕（SRT）")}</a>}</div>
        {project.output?.quality && <QualityReport quality={project.output.quality} redo={!!project.revision} />}</>
      : <><TaskStatus project={project} busy={busy} onResume={onResume} onCancel={onCancel} onCopy={onCopyDraft} onRelease={onRelease} />
        {base && <section className="mv-previous-result" aria-label={t("原成片")}>
          <h3>{t("原成片")}</h3>
          <p className="mv-hint">{t("预览成片完成前，原成片保持不变。")}</p>
          <video key={base.taskId} className="mv-result-video" controls preload="metadata" src={base.url} />
          {!["pending", "running"].includes(project.status) && <div className="mv-choices">
            <button disabled={settleBusy} onClick={() => void discard()}>{t("放弃预览")}</button></div>}
        </section>}
        {project.previousResult && <section className="mv-previous-result" aria-label={t("上一版成片")}>
          <h3>{t("上一版成片")}</h3>
          <p className="mv-hint">{t("新成片完成后会替换上一版；如需保留上一版，请先下载。")}</p>
          <video key={project.previousResult.taskId} className="mv-result-video" controls preload="metadata" src={project.previousResult.url} />
          <div className="mv-downloads"><a className="mv-download" href={project.previousResult.url} download>{t("下载上一版成片")}</a></div>
        </section>}</>}
    <div className="mv-publication">
      <DraftText form={form} name="publishTitle" label="视频发布标题" max={100} />
      <DraftText form={form} name="tags" label="短视频检索标签" max={160} />
      <button disabled={busy} onClick={onPublication}>{t("重新生成标题和标签")}</button>
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
          narration={narration} settings={(recompose, composePreview) => <>
            <CompositionSettings form={form} composition={project.revision!.composition} renderedSubtitles={project.revision!.draft.subtitles}
              captions={project.output?.captions} recompose={recompose} handlers={handlers} previewable={!result || previewable} anchor={settings}
              previewModes={previewable && <CaptionPreviewModes preview={previewing} draft={draft} timing={project.output!.captionTiming!}
                onChoose={next => void choosePreview(next, composePreview)} />}
              onPickNarrationVoice={onPickNarrationVoice}
              onPlayShot={result ? index => player.current?.playShot(index) : undefined} />
            {continuity}
          </>}
          onChange={onShots} onRevert={onRevertShots} onRevise={onRevise} />
        : <>{continuity}{draft.storyboard.length ? <StoryboardEditor shots={draft.storyboard} busy={busy} readOnly /> : <p className="mv-hint">{t("旧视频未保存详细分镜，可复制草稿补充分镜后重新制作。")}</p>}</>}
      <button disabled={busy || saving} onClick={() => onCopyDraft(CONFIRM_STEP)}>{t(project.revision ? "复制为新草稿修改其他设置" : "修改分镜并重新制作")}</button>
    </details>
  </section>;
}
