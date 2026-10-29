import { useState, type ReactNode } from "react";
import { CAPTION_WORDS_CHANGED, marketingCaptionErrors, marketingRenderKey, marketingReviewText, marketingShotNeedsClip, marketingVideoProfile,
  resolveMarketingSegments, type MarketingDraft, type MarketingNarrationClip, type MarketingProject, type MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { StoryboardEditor } from "./StoryboardEditor.js";
import { useConfirm } from "./ConfirmDialog.js";

/** Redo single shots of a stopped or made video: edit their text or just choose them.
 * The other shots keep their clips; only the chosen shots' seconds are billed. With no shot
 * chosen, changed music, captions or narration only compose the kept clips again. */
export function ShotRevision({ project, revision, draft, busy, saving, reviewPanel, narration, settings, onChange, onRevert, onRevise }: {
  project: MarketingProject; revision: NonNullable<MarketingProject["revision"]>; draft: MarketingDraft;
  busy: boolean; saving: boolean; reviewPanel: ReactNode;
  /** Twin narration takes of the saved draft, for a narrated video; null until loaded. */
  narration: MarketingNarrationClip[] | null;
  /** Composition settings shown above the shots, given a button that composes again once something changed, and,
   * for a made video that can be composed now, a preview composition beside it even with nothing changed; it
   * resolves true once submitted. */
  settings(recompose: ReactNode, composePreview?: () => Promise<boolean>): ReactNode;
  onChange(shots: MarketingShot[]): void; onRevert(): void;
  /** `narrationRedo`: shots whose failed take the user chose to make again. `preview`: compose a new video
   * beside the made one, to keep or discard once it is made. */
  onRevise(shots: number[], narrationRedo?: number[], preview?: boolean): void;
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
  // Only takes missing for the current lines and voice are made; a redone shot whose line is unchanged
  // keeps its take. Before the saved takes are loaded, count the shots a change of line or voice needs.
  const voiceChanged = composition.narration && JSON.stringify(draft.narration) !== JSON.stringify(revision.draft.narration);
  const takes = !composition.narration ? 0 : narration ? narration.filter(clip => clip.status === "missing").length
    : rendered.filter((_, index) => voiceChanged || reworded[index]).length;
  const made = project.status === "succeeded";
  const reviewIssue = !!project.review && project.reviewedScript === marketingReviewText(draft) && project.review.verdict !== "pass";
  // Redone shots use the model that made the kept clips.
  const profile = marketingVideoProfile(revision.modelId);
  let planError = "";
  try { if (profile) resolveMarketingSegments(draft, profile); }
  catch (error) { planError = error instanceof Error ? error.message : ""; }
  if (!planError && composition.localSubtitles && draft.subtitles && marketingCaptionErrors(draft).length) planError = CAPTION_WORDS_CHANGED;
  const toggle = (index: number) => setPicked(old => old.includes(index) ? old.filter(value => value !== index) : [...old, index]);
  const failedTakes = composition.narration ? narration?.filter(clip => clip.status === "failed") ?? [] : [];
  const takesRunning = composition.narration && !!narration?.some(clip => clip.status === "running");
  const shotList = (slots: number[]) => slots.map(index => index + 1).join(locale === "zh" ? "、" : ", ");
  /** Only the failed takes are made again, each one paid speech request; the redo is then submitted as before. */
  const retryTakes = async () => {
    const slots = failedTakes.map(clip => clip.slot);
    if (await confirm({ title: "重新合成配音", confirm: "重新合成", values: [shotList(slots)],
      message: "将重新合成第 {0} 镜配音，会产生费用；已成功的配音不会重新合成。完成后会继续提交本次修改。" })) onRevise(shots, slots);
  };
  const submit = async () => {
    const message = [shots.length ? "将重新生成第 {0} 镜，共 {1} 秒，会产生费用；其余 {2} 个镜头沿用已生成的片段，不收费。" : "将沿用全部已生成的片段重新合成成片，不调用视频模型。",
      takes ? "{3} 个镜头的配音需要重新合成，会产生费用。" : "", made ? "新成片完成后会替换当前成片；在此之前，当前成片仍可在「上一版成片」中查看和下载。" : ""].filter(Boolean).map(part => t(part)).join(locale === "zh" ? "" : " ");
    if (await confirm({ title: shots.length ? "重新生成镜头？" : "重新合成成片？", confirm: shots.length ? "重新生成" : "重新合成", message,
      values: [shotList(shots), seconds, rendered.length - shots.length, takes] })) onRevise(shots);
  };
  /** A preview replaces nothing and composes the kept clips without the video model, so it asks only when takes are paid for. */
  const composePreview = async () => {
    if (takes && !await confirm({ title: "生成预览成片？", confirm: "生成预览", values: [takes],
      message: "{0} 个镜头的配音需要重新合成，会产生费用。预览成片完成后，可以选择替换原成片或放弃。" })) return false;
    onRevise([], undefined, true);
    return true;
  };
  // Beside the caption settings, so a caption change needs no scrolling; shot redos stay below.
  const recompose = <>
    <button className="mv-primary" disabled={busy || saving || !changed || !!planError || !!shots.length} onClick={() => void submit()}>{t("重新合成成片")}</button>
    {!!shots.length && <p className="mv-hint">{t("已选择要重新生成的镜头，请在下方分镜处提交。")}</p>}
  </>;
  return <>
    {settings(recompose, made && !busy && !saving && !planError && !shots.length ? composePreview : undefined)}
    <StoryboardEditor shots={draft.storyboard} busy={busy} onChange={onChange} redo={{ selected, reasons, notes, onToggle: toggle, clips: revision.clips }} />
    {!made && edited && <p className="mv-hint">{t("「继续生成」按原分镜制作；要使用修改后的镜头，请点击下方的重新生成。")}</p>}
    {(edited || reviewIssue) && reviewPanel}
    {planError && <p className="mv-error" role="alert">{t(planError)}</p>}
    {/* A redo waiting for its takes says so beside the step buttons; this covers a reopened draft. */}
    {takesRunning && !busy && <p className="mv-hint" role="status">{t("正在合成改动镜头的配音")}</p>}
    {!!failedTakes.length && <div className="mv-audio-notice" role="alert">
      {failedTakes.map(clip => <p key={clip.slot}>{t("第 {0} 镜配音合成失败：{1}", [clip.slot + 1, t(clip.error ?? "配音合成失败，请稍后重新生成该镜配音。")])}</p>)}
      <button className="mv-primary" disabled={busy || saving || (!shots.length && !changed) || !!planError} onClick={() => void retryTakes()}>{t("重新合成配音")}</button>
    </div>}
    <div className="mv-choices">
      <button className="mv-primary" disabled={busy || saving || (!shots.length && !changed) || !!planError} onClick={() => void submit()}>
        {shots.length ? t("重新生成 {0} 个镜头并合成", [shots.length]) : changed ? t("重新合成成片") : t("选择要重新生成的镜头")}</button>
      {changed && <button disabled={busy || saving} onClick={onRevert}>{t("撤销修改")}</button>}
    </div>
    {confirmDialog}
  </>;
}
