import type { MarketingProject } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { videoFailure } from "./failure.js";
import { useConfirm } from "./ConfirmDialog.js";
import { CONFIRM_STEP } from "./production-checks.js";

/** Same action and wording as an unknown text result (TextOperationPanel); clips name how many are retried. */
export const UNKNOWN_CLIPS_MESSAGE = "有 {0} 个片段已发送给模型，但没有收到明确结果，可能已产生费用。重试只重新提交这些片段，会再次产生费用；已完成的片段会保留。确定继续吗？";

/** Progress of a submitted video, and for a stopped one: why, and the actions that can move it forward. */
export function TaskStatus({ project, busy, onResume, onCancel, onCopy, onRelease }: {
  project: MarketingProject; busy: boolean;
  onResume(): void; onCancel(): void; onCopy(step: number): void; onRelease(): void;
}) {
  const { t } = useI18n();
  const [confirmDialog, confirm] = useConfirm();
  const pending = project.status === "pending";
  const active = pending || project.status === "running";
  const cancelled = project.status === "cancelled";
  const unknown = active ? 0 : project.unknownSegments ?? 0;
  const failure = active || (cancelled && !unknown) ? undefined : videoFailure(project.errorCode, unknown);
  const stage = project.stage?.startsWith("片段完成 ") ? t("片段完成 {0}", [project.stage.slice(5)]) : t(project.stage || "等待生成");
  return <div className="mv-progress">
    <strong>{t(pending ? "排队中" : active ? "正在制作完整视频" : cancelled ? "已取消" : "生成未完成")}</strong>
    <progress aria-label={t("视频制作进度")} max="100" value={project.progress} />
    <span>{project.progress}% · {stage}</span>
    {active && <p className="mv-hint">{t("制作通常需要几分钟到十几分钟。可以离开此页面，任务会在后台继续，回来后进度会自动更新。")}</p>}
    {cancelled && !unknown && <p className="mv-hint">{t("已完成的片段会保留。点击继续生成可接着制作未完成的片段，会产生费用；如提示原任务正在收尾，请稍等片刻再试。")}</p>}
    {failure && <div className="mv-failure" role="alert">
      <p><strong>{t("原因")}</strong>{t(failure.reason)}</p>
      <p><strong>{t("下一步")}</strong>{t(failure.next)}</p>
    </div>}
    <div className="mv-choices">
      {active && <button disabled={busy} onClick={() => void confirm({ title: "取消视频生成？", message: "确定取消视频生成吗？已提交给模型的片段仍可能产生费用；已完成的片段会保留，之后可以继续生成。",
        confirm: "取消生成", cancel: "继续制作", danger: true }).then(ok => { if (ok) onCancel(); })}>{t("取消生成")}</button>}
      {((cancelled && !unknown) || failure?.actions.includes("resume")) && <button className="mv-primary" disabled={busy} onClick={onResume}>{t("继续生成")}</button>}
      {failure?.actions.includes("release") && <button className="mv-primary" disabled={busy} onClick={() => void confirm({ title: "核实后重试？", message: UNKNOWN_CLIPS_MESSAGE,
        values: [unknown], confirm: "重试", danger: true }).then(ok => { if (ok) onRelease(); })}>{t("核实后重试")}</button>}
      {failure?.actions.includes("copy") && <button disabled={busy}
        onClick={() => onCopy(failure.copyStep === "materials" ? 1 : failure.copyStep === "production" ? 2 : CONFIRM_STEP)}>{t("复制为新草稿重新制作")}</button>}
    </div>
    {pending && <p className="mv-hint">{t("排队超过 3 分钟时，系统会自动重新投递，不会重复创建任务。")}</p>}
    {!active && project.taskId && <details className="mv-task-details" open={failure?.actions.includes("support")}>
      <summary>{t("联系客服时提供的信息")}</summary>
      <p>{t("任务编号")}：{project.taskId}</p>
      {project.error && <p>{t("错误详情")}：{t(project.error)}</p>}
    </details>}
    {confirmDialog}
  </div>;
}
