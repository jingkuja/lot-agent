import { marketingCaptionSrt, type MarketingCaptions } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { useConfirm } from "../marketing-video/ConfirmDialog.js";
import { UNKNOWN_CLIPS_MESSAGE } from "../marketing-video/TaskStatus.js";
import type { Project } from "./api.js";
import { PresenterCaptions } from "./PresenterCaptions.js";

/** Guidance per stop reason; rewording a server message never changes the offered actions. */
const FAILURES: Record<string, { reason: string; next: string; resume?: boolean }> = {
  SUBMISSION_UNKNOWN: { reason: "有片段已提交给模型，但没有收到明确结果，可能已经计费。", next: "确认后可重新提交这些片段（可能重复计费），或联系客服核实。" },
  STATUS_UNCONFIRMED: { reason: "暂时无法查询片段状态。", next: "稍后点击继续生成，会查询原片段，不会重复提交。", resume: true },
  DOWNLOAD_INCOMPLETE: { reason: "片段已生成，但下载未完成。", next: "点击继续生成重新下载原片段，不会重复计费。", resume: true },
  TIMED_OUT: { reason: "片段等待时间过长。", next: "点击继续生成会继续查询原片段。", resume: true },
  GENERATION_FAILED: { reason: "模型未能生成片段，通常是肖像或底片中的人脸不清晰。", next: "可直接继续生成重试失败的片段，或复制为新草稿更换素材。", resume: true },
  // The gateway answered with an error: treated as not charged, so no duplicate-charge confirmation.
  GATEWAY_FAILED: { reason: "数字人视频模型服务暂时出错，部分片段没有生成。", next: "请稍后点击继续生成，只会重新提交这些片段，已完成的片段不会重做。", resume: true },
  REJECTED: { reason: "模型拒绝了本次请求。", next: "检查模型账号、素材后继续生成，或复制为新草稿修改。", resume: true },
  INPUT_INVALID: { reason: "素材不符合模型要求。", next: "复制为新草稿，更换肖像或底片后重新生成。" },
  COMPOSITION_FAILED: { reason: "片段已全部生成，合成成片时出错。", next: "点击继续生成重新合成，不会再次调用模型。", resume: true },
  CONFIG_MISSING: { reason: "服务配置不完整。", next: "请联系管理员检查服务配置后继续生成。", resume: true },
  MODEL_AUTH_REQUIRED: { reason: "模型账号不可用。", next: "重新登录后继续生成。", resume: true },
  JOB_BUSY: { reason: "该视频正在其他进程中处理。", next: "稍后刷新查看进度。", resume: true },
};

/** A submitted video: progress, or why it stopped and what can move it forward, or the result. */
export function PresenterResult({ project, busy, onCancel, onResume, onRelease, onCopy, onCaptions }: {
  project: Project; busy: boolean; onCancel(): void; onResume(): void; onRelease(): void; onCopy(): void;
  /** Compose the made video again with changed captions. */
  onCaptions(captions: MarketingCaptions | undefined): void;
}) {
  const { t } = useI18n();
  const [confirmDialog, confirm] = useConfirm();
  const result = project.status === "succeeded" ? project.output?.assets?.[0] : undefined;
  const pending = project.status === "pending";
  const active = pending || project.status === "running";
  const cancelled = project.status === "cancelled";
  const unknown = project.unknownClips ?? 0;
  const failure = active ? undefined : unknown ? FAILURES.SUBMISSION_UNKNOWN : cancelled ? undefined : FAILURES[project.errorCode ?? ""] ?? { reason: "生成未完成。", next: "可继续生成，或联系客服并提供任务编号。", resume: true };
  const stage = project.stage?.startsWith("片段完成 ") ? t("片段完成 {0}", [project.stage.slice(5)]) : t(project.stage || "等待生成");
  return <section className="mv-card mv-results">
    <div className="mv-section-head"><h2>{t("生成结果")}</h2><button disabled={busy} onClick={onCopy}>{t("复制为新草稿")}</button></div>
    {result ? <>
      <video className="mv-result-video" controls src={result.url} />
      <div className="mv-downloads"><a className="mv-download" href={result.url} download>{t("下载视频")}</a>
        {!!project.output?.captions?.length && <a className="mv-download" href={`data:application/x-subrip;charset=utf-8,${encodeURIComponent(marketingCaptionSrt(project.output.captions))}`} download="captions.srt">{t("下载字幕（SRT）")}</a>}</div>
      <p className="mv-hint">{t("口型、表情和身份一致性以实际成片为准，发布前请完整观看。")}</p>
      {project.draft.subtitles && project.output?.frame && <PresenterCaptions key={project.taskId} project={project} frame={project.output.frame} busy={busy} onApply={onCaptions} />}
    </> : <div className="mv-progress">
      <strong>{t(pending ? "排队中" : active ? "正在生成主播视频" : cancelled ? "已取消" : "生成未完成")}</strong>
      <progress aria-label={t("视频制作进度")} max="100" value={project.progress} />
      <span>{project.progress}% · {stage}</span>
      {active && <p className="mv-hint">{t("数字人片段通常需要 5–15 分钟，多段会排队生成。可以离开此页面，任务会在后台继续。")}</p>}
      {cancelled && !unknown && <p className="mv-hint">{t("已完成的片段会保留。继续生成会接着制作未完成的片段（可能产生费用）。")}</p>}
      {failure && <div className="mv-failure" role="alert">
        <p><strong>{t("原因")}</strong>{t(failure.reason)}</p>
        <p><strong>{t("下一步")}</strong>{t(failure.next)}</p>
      </div>}
      <div className="mv-choices">
        {active && <button disabled={busy} onClick={() => void confirm({ title: "取消视频生成？", message: "已提交给模型的片段仍可能计费；已完成的片段会保留，之后可以继续生成。", confirm: "取消生成", cancel: "继续制作" }).then(ok => { if (ok) onCancel(); })}>{t("取消生成")}</button>}
        {pending && <button disabled={busy} onClick={onResume}>{t("重新排队")}</button>}
        {!active && !unknown && (cancelled || failure?.resume) && <button className="mv-primary" disabled={busy} onClick={onResume}>{t("继续生成")}</button>}
        {!active && !!unknown && <button className="mv-primary" disabled={busy} onClick={() => void confirm({ title: "核实后重试？",
          message: UNKNOWN_CLIPS_MESSAGE, values: [unknown], confirm: "重试" }).then(ok => { if (ok) onRelease(); })}>{t("核实后重试")}</button>}
      </div>
      {!active && <details className="mv-task-details">
        <summary>{t("联系客服时提供的信息")}</summary>
        <p>{t("任务编号")}：{project.taskId}</p>
        {project.error && <p>{t("错误详情")}：{project.error}</p>}
      </details>}
    </div>}
    <details className="mv-script-review"><summary>{t("查看口播文案")}</summary><p>{project.draft.script}</p></details>
    {confirmDialog}
  </section>;
}
