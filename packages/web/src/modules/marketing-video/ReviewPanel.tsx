import { useState } from "react";
import { applyMarketingReviewSuggestion, marketingReviewFieldText, updateMarketingReviewField, type MarketingDraft, type MarketingReview, type MarketingReviewIssue } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";

const fieldLabels = {
  script: "视频口播文案", publishTitle: "视频发布标题", tags: "短视频检索标签", background: "背景/场景补充描述", continuity: "统一人物与场景设定",
  "storyboard.script": "分镜口播", "storyboard.visual": "画面内容", "storyboard.action": "人物与产品动作", "storyboard.camera": "景别与镜头运动",
};
const fieldLimits = { script: 2000, publishTitle: 100, tags: 160, background: 600, continuity: 400, "storyboard.script": 600, "storyboard.visual": 600, "storyboard.action": 400, "storyboard.camera": 400 };
const sourceLabels = { "risk-table": "风险词规则表", douyin: "抖音社区规则", xiaohongshu: "小红书社区规则" };

function ReviewIssue({ issue, draft, busy, onApply }: {
  issue: MarketingReviewIssue; draft: MarketingDraft; busy: boolean; onApply: (draft: MarketingDraft) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const original = marketingReviewFieldText(draft, issue);
  const [value, setValue] = useState(original ?? "");
  const suggested = applyMarketingReviewSuggestion(draft, issue);
  const edited = editing && value !== original ? updateMarketingReviewField(draft, issue, value) : null;
  const label = issue.field ? t(fieldLabels[issue.field]) : t("风险内容");
  const location = issue.shotIndex === undefined ? label : `${t("第 {0} 镜", [issue.shotIndex + 1])} · ${label}`;
  return <article className="mv-review-issue" aria-label={location}>
    <header><strong>{location}</strong><span>{t(issue.severity === "reject" ? "请修改风险内容" : "有内容需要核实")}</span></header>
    {issue.source && <p className="mv-review-source">{t(sourceLabels[issue.source])}{issue.ruleId ? ` · ${issue.ruleId}` : ""}</p>}
    <blockquote>{issue.text}</blockquote>
    <p>{t("风险原因")}：{issue.reason}</p>
    <p>{t("修改建议")}：{issue.suggestion || t("删除这段风险内容")}</p>
    {editing ? <div className="mv-review-edit">
      <label className="mv-field"><span>{t("修改内容")} · {location}</span><textarea autoFocus rows={4} maxLength={issue.field ? fieldLimits[issue.field] : 2000} value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></label>
      {issue.field === "script" && !!draft.storyboard.length && <p className="mv-hint">{t("修改整篇口播文案后需要重新生成分镜。")}</p>}
      <div className="mv-review-actions"><button disabled={busy || !edited} onClick={() => { if (edited) onApply(edited); }}>{t("保存修改")}</button><button disabled={busy} onClick={() => setEditing(false)}>{t("取消")}</button></div>
    </div> : <div className="mv-review-actions">
      <button disabled={busy || !suggested} onClick={() => { if (suggested) onApply(suggested); }}>{t("一键修改")}</button>
      <button disabled={busy || original === null} onClick={() => { setValue(original ?? ""); setEditing(true); }}>{t("自己修改")}</button>
    </div>}
    {original === null && <p className="mv-hint">{t("无法准确定位此条内容，请在正文或分镜中修改后重新检查。")}</p>}
    {original !== null && !suggested && !editing && <p className="mv-hint">{t("此条建议需要结合上下文修改，请选择自己修改。")}</p>}
  </article>;
}

/** Fixes only change the draft. A `stale` check is the last one before those edits: it lists the
 * findings whose excerpt is still there until the user checks again. */
export function ReviewPanel({ review, draft, busy, onApply, stale = false }: {
  review: MarketingReview; draft: MarketingDraft; busy: boolean; onApply: (draft: MarketingDraft) => void; stale?: boolean;
}) {
  const { t } = useI18n();
  const issues = stale ? review.issues.filter(issue => marketingReviewFieldText(draft, issue)?.includes(issue.text)) : review.issues;
  const verdict = !stale ? review.verdict : issues.some(issue => issue.severity === "reject") ? "reject" : issues.length ? "suspect" : "";
  return <div className={`mv-review${verdict ? ` mv-review-${verdict}` : ""}`}>
    <strong role="status">{t(stale ? "内容已修改，请点击“检查当前文案”重新检查。" : ({ pass: "文案检查完成，未发现明显风险", suspect: "有内容需要核实", reject: "请修改风险内容" })[review.verdict])}</strong>
    {issues.map((issue, index) => <ReviewIssue key={`${issue.field}:${issue.shotIndex}:${index}:${issue.text}`} issue={issue} draft={draft} busy={busy} onApply={onApply} />)}
  </div>;
}
