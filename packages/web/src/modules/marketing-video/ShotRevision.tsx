import { useState, type ReactNode } from "react";
import { marketingReviewText, marketingShotChanged, marketingVideoProfile, resolveMarketingSegments, type MarketingDraft, type MarketingProject, type MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { StoryboardEditor } from "./StoryboardEditor.js";
import { useConfirm } from "./ConfirmDialog.js";

/** Redo single shots of a stopped or made video: edit their text or just choose them.
 * The other shots keep their clips; only the chosen shots' seconds are billed. */
export function ShotRevision({ project, revision, draft, busy, saving, reviewPanel, onChange, onRevert, onRevise }: {
  project: MarketingProject; revision: NonNullable<MarketingProject["revision"]>; draft: MarketingDraft;
  busy: boolean; saving: boolean; reviewPanel: ReactNode;
  onChange(shots: MarketingShot[]): void; onRevert(): void; onRevise(shots: number[]): void;
}) {
  const { t, locale } = useI18n();
  const [confirmDialog, confirm] = useConfirm();
  const [picked, setPicked] = useState<number[]>([]);
  const rendered = revision.draft.storyboard;
  const reasons = rendered.map((shot, index) => !revision.reusable[index] ? "没有可用片段" : marketingShotChanged(shot, draft.storyboard[index]) ? "已修改" : undefined);
  const selected = rendered.map((_, index) => !!reasons[index] || picked.includes(index));
  const shots = selected.flatMap((on, index) => on ? [index] : []);
  const seconds = shots.reduce((sum, index) => sum + rendered[index].durationSec, 0);
  const edited = reasons.includes("已修改");
  const made = project.status === "succeeded";
  const reviewIssue = !!project.review && project.reviewedScript === marketingReviewText(draft) && project.review.verdict !== "pass";
  // Redone shots use the model that made the kept clips.
  const profile = marketingVideoProfile(revision.modelId);
  let planError = "";
  try { if (profile) resolveMarketingSegments(draft, profile); }
  catch (error) { planError = error instanceof Error ? error.message : ""; }
  const toggle = (index: number) => setPicked(old => old.includes(index) ? old.filter(value => value !== index) : [...old, index]);
  const submit = async () => {
    if (await confirm({ title: "重新生成镜头？", confirm: "重新生成", values: [shots.map(index => index + 1).join(locale === "zh" ? "、" : ", "), seconds, rendered.length - shots.length],
      message: made ? "将重新生成第 {0} 镜，共 {1} 秒，按视频模型计费；其余 {2} 个镜头沿用已生成的片段，不再计费。新成片完成前不再显示当前成片，如需保留请先下载。"
        : "将重新生成第 {0} 镜，共 {1} 秒，按视频模型计费；其余 {2} 个镜头沿用已生成的片段，不再计费。" })) onRevise(shots);
  };
  return <>
    <StoryboardEditor shots={draft.storyboard} busy={busy} onChange={onChange} redo={{ selected, reasons, onToggle: toggle }} />
    {!made && edited && <p className="mv-hint">{t("「继续生成」按原分镜制作；要使用修改后的镜头，请点击下方的重新生成。")}</p>}
    {(edited || reviewIssue) && reviewPanel}
    {planError && <p className="mv-error" role="alert">{t(planError)}</p>}
    <div className="mv-choices">
      <button className="mv-primary" disabled={busy || saving || !shots.length || !!planError} onClick={() => void submit()}>
        {shots.length ? t("重新生成 {0} 个镜头并合成", [shots.length]) : t("选择要重新生成的镜头")}</button>
      {edited && <button disabled={busy || saving} onClick={onRevert}>{t("撤销分镜修改")}</button>}
    </div>
    {confirmDialog}
  </>;
}
