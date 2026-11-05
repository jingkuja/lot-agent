import { useI18n } from "../../../i18n/index.js";
import {
  OPPORTUNITY_TYPE_LABELS, OUTCOME_LABELS, READINESS_LABELS, RELATIONSHIP_LABELS,
  type OpportunityItem, type OpportunityType,
} from "../types.js";

export const PRIORITY_LABELS = { high: "高优先", normal: "中优先", low: "低优先" } as const;
export const FIRST_TYPES: OpportunityType[] = ["prospect_progress", "silent_reengage", "event_invitation", "renewal", "risk_recovery"];
export type FilterValues = {
  readiness: string; priority: string; opportunityType: string; relationshipStage: string;
  product: string; suggestedFrom: string; suggestedTo: string;
};
export const EMPTY_FILTERS: FilterValues = {
  readiness: "", priority: "", opportunityType: "", relationshipStage: "", product: "", suggestedFrom: "", suggestedTo: "",
};
export type OpportunityDialog = "accept" | "snooze" | "dismiss" | "reschedule" | "result";

export function OpportunityFilters({ values, onChange }: { values: FilterValues; onChange: (value: FilterValues) => void }) {
  const { t } = useI18n();
  const field = (key: string, value: string) => onChange({ ...values, [key]: value });
  return (
    <section className="de-filter-card de-opportunity-filters" aria-label={t("商机筛选")}>
      <label className="de-filter-select">
        <span>{t("准备度")}</span>
        <select value={values.readiness} onChange={(e) => field("readiness", e.target.value)}>
          <option value="">{t("全部")}</option>
          {Object.entries(READINESS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {t(l)}
            </option>
          ))}
        </select>
      </label>
      <label className="de-filter-select">
        <span>{t("优先级")}</span>
        <select value={values.priority} onChange={(e) => field("priority", e.target.value)}>
          <option value="">{t("全部")}</option>
          <option value="high">{t("高")}</option>
          <option value="normal">{t("中")}</option>
          <option value="low">{t("低")}</option>
        </select>
      </label>
      <label className="de-filter-select">
        <span>{t("机会类型")}</span>
        <select value={values.opportunityType} onChange={(e) => field("opportunityType", e.target.value)}>
          <option value="">{t("全部")}</option>
          {FIRST_TYPES.map((v) => (
            <option key={v} value={v}>
              {t(OPPORTUNITY_TYPE_LABELS[v])}
            </option>
          ))}
        </select>
      </label>
      <label className="de-filter-select">
        <span>{t("客户阶段")}</span>
        <select value={values.relationshipStage} onChange={(e) => field("relationshipStage", e.target.value)}>
          <option value="">{t("全部")}</option>
          {Object.entries(RELATIONSHIP_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {t(l)}
            </option>
          ))}
        </select>
      </label>
      <label className="de-filter-select de-opportunity-product-filter">
        <span>{t("产品")}</span>
        <input placeholder={t("产品名称")} value={values.product} onChange={(e) => field("product", e.target.value)} />
      </label>
      <label className="de-filter-select">
        <span>{t("发现自")}</span>
        <input type="date" value={values.suggestedFrom} onChange={(event) => field("suggestedFrom", event.target.value)} />
      </label>
      <label className="de-filter-select">
        <span>{t("发现至")}</span>
        <input type="date" value={values.suggestedTo} onChange={(event) => field("suggestedTo", event.target.value)} />
      </label>
      {Object.values(values).some(Boolean) && (
        <button className="de-quiet-button" onClick={() => onChange(EMPTY_FILTERS)}>
          {t("清除筛选")}
        </button>
      )}
    </section>
  );
}

export function OpportunityCard({ item, onOpenProfile, onAction, onResume, onExecute, onCancel, onDraftOutreach }: {
  item: OpportunityItem; onOpenProfile: (id: string) => void;
  onAction: (item: OpportunityItem, action: OpportunityDialog) => void;
  onResume: () => void; onExecute: () => void; onCancel: () => void;
  /** Writing happens in the conversation, so the message reaches the library. */
  onDraftOutreach: (item: OpportunityItem) => void;
}) {
  const { t, locale } = useI18n();
  const blocked = item.riskFlags.some((risk) => risk.blocking);
  return (
    <article
      className={`de-opportunity-card priority-${item.priority} ${item.overdue ? "is-overdue" : ""} ${blocked ? "is-blocked" : ""}`}
    >
      <header>
        <div className="de-opportunity-identity">
          <button className="de-opportunity-customer" onClick={() => onOpenProfile(item.profileId)}>
            <span>{item.customerName.slice(0, 1)}</span>
            <strong>
              {item.customerName}
              <small>{item.organization || t(RELATIONSHIP_LABELS[item.relationshipStage])}</small>
            </strong>
          </button>
          <button type="button" className="de-talk-track-toggle" onClick={() => onDraftOutreach(item)}>
            <span aria-hidden="true">✦</span>
            {t("联系话术")}
          </button>
        </div>
        <div className="de-opportunity-badges">
          <i className={`source-${item.source}`}>{item.source === "manual" ? t("确定提醒") : t("AI 商机")}</i>
          <span>{t(OPPORTUNITY_TYPE_LABELS[item.opportunityType])}</span>
          <b className={`priority-${item.priority}`}>{t(PRIORITY_LABELS[item.priority])}</b>
          <em>{t(READINESS_LABELS[item.readiness])}</em>
        </div>
      </header>
            <div className="de-opportunity-body">
        <div className="de-opportunity-main">
          <h2>{item.title}</h2>
          <section className="de-opportunity-section">
            <h3>{t("策略建议")}</h3>
            <p>{item.reason || t("结合客户近况给出跟进策略")}</p>
          </section>
          <section className="de-opportunity-section">
            <h3>{t("具体行动")}</h3>
            <p>{item.objective}</p>
            <div className="de-opportunity-action-meta">
              <span>
                {t("沟通方式：")}
                {item.followUpMethod || t("根据客户偏好")}
              </span>
              {item.productName && (
                <span>
                  {t("关联产品：")}
                  {item.productName}
                </span>
              )}
            </div>
          </section>
          <section className="de-opportunity-section">
            <h3>{t("为什么现在")}</h3>
            <ul>
              {item.evidence.map((evidence, index) => (
                <li key={`${evidence.sourceId ?? evidence.sourceType}-${index}`}>
                  <time>{shortDate(evidence.occurredAt, locale)}</time>
                  <span>{evidence.fact}</span>
                </li>
              ))}
            </ul>
          </section>
          {item.riskFlags.map((risk) => (
            <div key={risk.code} className={`de-opportunity-risk ${risk.blocking ? "blocking" : ""}`}>
              ⚠ {risk.message}
            </div>
          ))}
          {(item.view === "snoozed" || item.snoozedUntil) && item.view !== "pending" && (
            <div className="de-opportunity-later-trail">
              <strong>{t("稍后处理轨迹")}</strong>
              <span>{item.decisionReason || t("已标记稍后处理")}</span>
              {item.snoozedUntil && (
                <time>
                  {t("恢复：")}
                  {formatTime(item.snoozedUntil, locale)}
                </time>
              )}
              {item.updatedAt && (
                <small>
                  {t("记录于")}
                  {formatTime(item.updatedAt, locale)}
                </small>
              )}
            </div>
          )}
        </div>
        <aside className="de-opportunity-task-aside">
          <span>{t("可一键任务")}</span>
          <strong>
            {item.view === "pending" || item.view === "snoozed"
              ? t("采纳后生成跟进任务")
              : item.view === "in_progress"
                ? t("执行中的跟进任务")
                : item.view === "awaiting_result"
                  ? t("待回填结果")
                  : t("任务结果")}
          </strong>
          <p>
            {item.view === "snoozed" && item.snoozedUntil
              ? t("稍后至 {0}", [formatTime(item.snoozedUntil, locale)])
              : item.scheduledAt
                ? formatTime(item.scheduledAt, locale)
                : formatTime(item.suggestedAt, locale)}
          </p>
          {item.resultCriteria && (
            <small>
              {t("成功口径：")}
              {item.resultCriteria}
            </small>
          )}
          {!item.resultCriteria && <small>{t("成功口径：获得有效回复或明确下一步")}</small>}
          {item.productName && (
            <small>
              {t("关联：")}
              {item.productName}
            </small>
          )}
        </aside>
      </div>
      <footer>
        {item.view === "pending" && (
          <>
            <button className="de-primary-button" disabled={blocked} onClick={() => onAction(item, "accept")}>
              {t("采纳并确认行动")}
            </button>
            <button className="de-secondary-button" onClick={() => onAction(item, "snooze")}>
              {t("稍后")}
            </button>
            <button className="de-quiet-button" onClick={() => onAction(item, "dismiss")}>
              {t("忽略")}
            </button>
          </>
        )}
        {item.view === "snoozed" && (
          <>
            <button className="de-primary-button" onClick={onResume}>
              {t("提前恢复")}
            </button>
            <button className="de-secondary-button" disabled={blocked} onClick={() => onAction(item, "accept")}>
              {t("采纳并确认行动")}
            </button>
            <button className="de-quiet-button" onClick={() => onAction(item, "dismiss")}>
              {t("忽略")}
            </button>
          </>
        )}
        {item.view === "in_progress" && (
          <>
            <button className="de-primary-button" onClick={onExecute}>
              {t("标记已执行")}
            </button>
            <button className="de-secondary-button" onClick={() => onAction(item, "reschedule")}>
              {t("改时间")}
            </button>
            <button className="de-quiet-button" onClick={onCancel}>
              {t("取消")}
            </button>
          </>
        )}
        {item.view === "awaiting_result" && (
          <button className="de-primary-button" onClick={() => onAction(item, "result")}>
            {t("回填结果")}
          </button>
        )}
        {item.view === "completed" && (
          <>
            <span className="de-opportunity-outcome">
              {item.closeReason === "overdue_closed" ? t("已逾期关闭") : t(OUTCOME_LABELS[item.outcome ?? ""]) || t("已取消")}
            </span>
            {item.customerQuote && <q>{item.customerQuote}</q>}
          </>
        )}
        <button className="de-opportunity-profile-link" onClick={() => onOpenProfile(item.profileId)}>
          {t("查看画像与来源 →")}
        </button>
      </footer>
    </article>
  );
}

export function formatTime(value: string, locale = "zh-CN") {
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function shortDate(value: string, locale = "zh-CN") { return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(new Date(value)); }
