import { useI18n } from "../../../i18n/index.js";
import { useRef, useState } from "react";
import { shouldSubmitComposer } from "../../../lib/composer-keyboard.js";
import { employeeApi } from "../api.js";
import {
  OPPORTUNITY_TYPE_LABELS, OUTCOME_LABELS, READINESS_LABELS, RELATIONSHIP_LABELS,
  type OpportunityItem, type OpportunityType, type TalkTrackIntent, type TalkTrackMessage,
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
  /** Hands the writing to the conversation; without it the card keeps its own assistant. */
  onDraftOutreach?: (item: OpportunityItem) => void;
}) {
  const { t, locale } = useI18n();
  const [talkOpen, setTalkOpen] = useState(false);
  const blocked = item.riskFlags.some((risk) => risk.blocking);
  return (
    <article
      className={`de-opportunity-card priority-${item.priority} ${item.overdue ? "is-overdue" : ""} ${blocked ? "is-blocked" : ""} ${talkOpen ? "has-talk-track" : ""}`}
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
          <button
            type="button"
            className={`de-talk-track-toggle${talkOpen ? " is-open" : ""}`}
            aria-expanded={onDraftOutreach ? undefined : talkOpen}
            onClick={() => (onDraftOutreach ? onDraftOutreach(item) : setTalkOpen((value) => !value))}
          >
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
      {!onDraftOutreach && <TalkTrackAssistant item={item} open={talkOpen} onClose={() => setTalkOpen(false)} />}
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

const TALK_TRACK_PRESETS: Array<{ intent: TalkTrackIntent; label: string; prompt: string }> = [
  { intent: "maintenance", label: "维护问候", prompt: "请生成一段自然、不带强推销感的客户维护问候话术。" },
  { intent: "follow_up", label: "跟进联络", prompt: "请根据当前事项生成一段可直接发送的跟进联络话术，明确但不要给客户压力。" },
  { intent: "sales", label: "产品推介", prompt: "请结合客户需求和已核实的产品资料，生成一段有针对性的产品推介话术。" },
];

function TalkTrackAssistant({ item, open, onClose }: { item: OpportunityItem; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const compositionActiveRef = useRef(false);
  const [intent, setIntent] = useState<TalkTrackIntent>("follow_up");
  const [messages, setMessages] = useState<TalkTrackMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (content: string, nextIntent: TalkTrackIntent = intent) => {
    const message = content.trim();
    if (!message || loading) return;
    const history = messages.slice(-12);
    setIntent(nextIntent);
    setMessages((current) => [...current, { role: "user", content: message }]);
    setInput(""); setLoading(true); setError(null);
    try {
      const result = await employeeApi.generateOpportunityTalkTrack(item.id, { intent: nextIntent, message, history });
      setMessages((current) => [...current, { role: "assistant", content: result.reply }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "话术生成失败，请重试");
    } finally { setLoading(false); }
  };

  if (!open) return null;
  return (
    <section className="de-talk-track-panel" aria-label={t("{0}联系话术助手", [item.customerName])}>
      <header>
        <div>
          <strong>{t("单客户话术助手")}</strong>
          <span>
            {t("已带入")}
            {item.customerName} {t("的画像、当前事项")}
            {item.productName ? t("和{0}资料", [item.productName]) : ""}
          </span>
        </div>
        <button type="button" onClick={onClose} aria-label={t("收起话术助手")}>
          ×
        </button>
      </header>
      <div className="de-talk-track-presets">
        {TALK_TRACK_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.intent}
            disabled={loading}
            className={intent === preset.intent ? "active" : ""}
            onClick={() => void send(preset.prompt, preset.intent)}
          >
            {t(preset.label)}
          </button>
        ))}
      </div>
      {messages.length === 0 && (
        <div className="de-talk-track-empty">
          <span>✦</span>
          <p>{t("选择一种场景直接生成，或在下方说明渠道、语气和想达到的目的。")}</p>
        </div>
      )}
      {messages.length > 0 && (
        <div className="de-talk-track-messages">
          {messages.map((message, index) => (
            <div key={`${message.role}-${index}`} className={`de-talk-track-message ${message.role}`}>
              <span>{message.role === "assistant" ? t("参谋") : t("你")}</span>
              <p>{message.content}</p>
              {message.role === "assistant" && (
                <button type="button" onClick={() => void navigator.clipboard.writeText(message.content)}>
                  {t("复制")}
                </button>
              )}
            </div>
          ))}
          {loading && (
            <div className="de-talk-track-thinking">
              <i />
              <span>{t("正在结合客户信息生成…")}</span>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="de-talk-track-error" role="alert">
          {t(error)}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <div className="de-talk-track-composer">
          <textarea
            value={input}
            maxLength={2_000}
            rows={2}
            disabled={loading}
            placeholder={t("例如：语气更熟悉一点，适合微信，先询问对方是否方便……")}
            onChange={(event) => setInput(event.target.value)}
            onCompositionStart={() => {
              compositionActiveRef.current = true;
            }}
            onCompositionEnd={() => {
              compositionActiveRef.current = false;
            }}
            onKeyDown={(event) => {
              if (
                shouldSubmitComposer(
                  { key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode },
                  compositionActiveRef.current
                )
              ) {
                event.preventDefault();
                void send(input);
              }
            }}
          />
        </div>
        <button type="submit" className="de-primary-button" disabled={loading || !input.trim()}>
          {loading ? t("生成中") : t("发送")}
        </button>
      </form>
      <small>{t("AI 话术仅供参考，发送前请核对客户事实、产品承诺和价格权益。")}</small>
    </section>
  );
}

export function formatTime(value: string, locale = "zh-CN") {
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function shortDate(value: string, locale = "zh-CN") { return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(new Date(value)); }
