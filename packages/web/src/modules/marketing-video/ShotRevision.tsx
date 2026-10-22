import { useState, type ReactNode } from "react";
import { CAPTION_WORDS_CHANGED, marketingCaptionErrors, marketingRenderKey, marketingReviewText, marketingShotNeedsClip, marketingVideoProfile, resolveMarketingSegments, type MarketingDraft, type MarketingProject, type MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { StoryboardEditor } from "./StoryboardEditor.js";
import { useConfirm } from "./ConfirmDialog.js";

/** Redo single shots of a stopped or made video: edit their text or just choose them.
 * The other shots keep their clips; only the chosen shots' seconds are billed. With no shot
 * chosen, changed music, captions or narration only compose the kept clips again. */
export function ShotRevision({ project, revision, draft, busy, saving, reviewPanel, settings, onChange, onRevert, onRevise }: {
  project: MarketingProject; revision: NonNullable<MarketingProject["revision"]>; draft: MarketingDraft;
  busy: boolean; saving: boolean; reviewPanel: ReactNode;
  /** Composition settings shown above the shots, given a button that only composes again. */
  settings(recompose: ReactNode): ReactNode;
  onChange(shots: MarketingShot[]): void; onRevert(): void; onRevise(shots: number[]): void;
}) {
  const { t, locale } = useI18n();
  const [confirmDialog, confirm] = useConfirm();
  const [picked, setPicked] = useState<number[]>([]);
  const rendered = revision.draft.storyboard;
  const { composition } = revision;
  const reasons = rendered.map((shot, index) => !revision.reusable[index] ? "没有可用片段" : marketingShotNeedsClip(shot, draft.storyboard[index], composition) ? "已修改" : undefined);
  // A narrated shot whose line alone changed keeps its picture unless the user chooses it.
  const reworded = rendered.map((shot, index) => shot.script !== draft.storyboard[index]?.script);
  const notes = reworded.map(changed => changed ? "口播已修改，保留画面，只更新配音和字幕" : undefined);
  const selected = rendered.map((_, index) => !!reasons[index] || picked.includes(index));
  const shots = selected.flatMap((on, index) => on ? [index] : []);
  const seconds = shots.reduce((sum, index) => sum + rendered[index].durationSec, 0);
  const edited = reasons.includes("已修改");
  const changed = marketingRenderKey(draft) !== marketingRenderKey(revision.draft);
  // New voice settings need every take again; otherwise only reworded or redone shots do.
  const voiceChanged = composition.narration && JSON.stringify(draft.narration) !== JSON.stringify(revision.draft.narration);
  const takes = composition.narration ? rendered.filter((_, index) => voiceChanged || reworded[index] || selected[index]).length : 0;
  const made = project.status === "succeeded";
  const reviewIssue = !!project.review && project.reviewedScript === marketingReviewText(draft) && project.review.verdict !== "pass";
  // Redone shots use the model that made the kept clips.
  const profile = marketingVideoProfile(revision.modelId);
  let planError = "";
  try { if (profile) resolveMarketingSegments(draft, profile); }
  catch (error) { planError = error instanceof Error ? error.message : ""; }
  if (!planError && composition.localSubtitles && draft.subtitles && marketingCaptionErrors(draft).length) planError = CAPTION_WORDS_CHANGED;
  const toggle = (index: number) => setPicked(old => old.includes(index) ? old.filter(value => value !== index) : [...old, index]);
  const submit = async () => {
    const message = [shots.length ? "将重新生成第 {0} 镜，共 {1} 秒，按视频模型计费；其余 {2} 个镜头沿用已生成的片段，不再计费。" : "将沿用全部已生成的片段重新合成成片，不调用视频模型。",
      takes ? "{3} 个镜头的配音需要重新合成，按语音合成计费。" : "", made ? "新成片完成前不再显示当前成片，如需保留请先下载。" : ""].filter(Boolean).map(part => t(part)).join(locale === "zh" ? "" : " ");
    if (await confirm({ title: shots.length ? "重新生成镜头？" : "重新合成成片？", confirm: shots.length ? "重新生成" : "重新合成", message,
      values: [shots.map(index => index + 1).join(locale === "zh" ? "、" : ", "), seconds, rendered.length - shots.length, takes] })) onRevise(shots);
  };
  // Beside the caption settings, so a caption change needs no scrolling; shot redos stay below.
  const recompose = <>
    <button className="mv-primary" disabled={busy || saving || !changed || !!planError || !!shots.length} onClick={() => void submit()}>{t("重新合成成片")}</button>
    {!!shots.length && <p className="mv-hint">{t("已选择要重新生成的镜头，请在下方分镜处提交。")}</p>}
  </>;
  return <>
    {settings(recompose)}
    <StoryboardEditor shots={draft.storyboard} busy={busy} onChange={onChange} redo={{ selected, reasons, notes, onToggle: toggle }} />
    {!made && edited && <p className="mv-hint">{t("「继续生成」按原分镜制作；要使用修改后的镜头，请点击下方的重新生成。")}</p>}
    {(edited || reviewIssue) && reviewPanel}
    {planError && <p className="mv-error" role="alert">{t(planError)}</p>}
    <div className="mv-choices">
      <button className="mv-primary" disabled={busy || saving || (!shots.length && !changed) || !!planError} onClick={() => void submit()}>
        {shots.length ? t("重新生成 {0} 个镜头并合成", [shots.length]) : changed ? t("重新合成成片") : t("选择要重新生成的镜头")}</button>
      {changed && <button disabled={busy || saving} onClick={onRevert}>{t("撤销修改")}</button>}
    </div>
    {confirmDialog}
  </>;
}
