import { useI18n } from "../../../i18n/index.js";
import { useEffect, useState } from "react";
import { employeeApi } from "../api.js";
import {
  OPPORTUNITY_TYPE_LABELS, OUTCOME_LABELS, RELATIONSHIP_LABELS,
  type OpportunityItem, type OpportunityType,
} from "../types.js";
import { FIRST_TYPES, type OpportunityDialog } from "./OpportunityCard.js";

const DISMISS_REASONS = ["当前不合适", "已经处理", "客户明确拒绝", "信息不准确", "不再跟进"];

/** The dialogs behind an opportunity card, for pages that show cards outside the old queue. */
export function OpportunityDialogs({ active, dialog, onClose, mutate, onOpenProfile }: {
  active: OpportunityItem | null;
  dialog: OpportunityDialog | null;
  onClose: () => void;
  mutate: (operation: () => Promise<unknown>) => Promise<void>;
  onOpenProfile: (id: string) => void;
}) {
  if (!active) return null;
  const actionId = active.actionId!;
  if (dialog === "accept") return <AcceptDialog item={active} onClose={onClose} onSave={(input) => void mutate(() =>
    employeeApi.decideOpportunity(active.opportunityId, { decision: "accept", ...input }))} />;
  if (dialog === "snooze") return <SnoozeDialog onClose={onClose} onSave={(snoozedUntil) => void mutate(() =>
    employeeApi.decideOpportunity(active.opportunityId, { decision: "snooze", snoozedUntil }))} />;
  if (dialog === "dismiss") return <DismissDialog onClose={onClose} onSave={(reason) => {
    const profileId = active.profileId;
    void mutate(() => employeeApi.decideOpportunity(active.opportunityId, { decision: "dismiss", reason }))
      .then(() => { if (reason === "信息不准确") onOpenProfile(profileId); });
  }} />;
  if (dialog === "reschedule") return <RescheduleDialog item={active} onClose={onClose} onSave={(scheduledAt) => void mutate(() =>
    employeeApi.updateOpportunityAction(actionId, { operation: "reschedule", scheduledAt, version: active.actionVersion }))} />;
  if (dialog === "result") return <ResultDialog item={active} onClose={onClose} onSave={(input) => void mutate(() =>
    employeeApi.addOpportunityActionResult(actionId, input))} />;
  return null;
}

function DialogFrame({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="de-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="de-modal de-opportunity-dialog" role="dialog" aria-modal="true">
        <header className="de-modal-head">
          <div>
            <h2>{t(title)}</h2>
          </div>
          <button className="de-icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function AcceptDialog({ item, onClose, onSave }: { item: OpportunityItem; onClose: () => void; onSave: (input: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const [objective, setObjective] = useState(item.objective); const [method, setMethod] = useState(item.followUpMethod || "企微/微信");
  const [scheduledAt, setScheduledAt] = useState(localInput(item.scheduledAt || item.suggestedAt));
  const [criteria, setCriteria] = useState(item.resultCriteria || "获得有效回复或下一步");
  return (
    <DialogFrame title={t("确认跟进行动")} onClose={onClose}>
      <form
        className="de-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ objective, followUpMethod: method, scheduledAt: new Date(scheduledAt).toISOString(), resultCriteria: criteria });
        }}
      >
        <div className="de-dialog-context">
          <strong>
            {item.customerName} · {t(OPPORTUNITY_TYPE_LABELS[item.opportunityType])}
          </strong>
          <p>{item.reason}</p>
        </div>
        <div className="de-form-grid">
          <label>
            <span>{t("推荐目标")}</span>
            <textarea value={objective} onChange={(e) => setObjective(e.target.value)} required />
          </label>
          <label>
            <span>{t("结果口径")}</span>
            <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} required />
          </label>
          <label>
            <span>{t("沟通方式")}</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option>{t("企微/微信")}</option>
              <option>{t("电话")}</option>
              <option>{t("邮件")}</option>
              <option>{t("线下拜访")}</option>
            </select>
          </label>
          <label>
            <span>{t("计划时间")}</span>
            <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required />
          </label>
        </div>
        <p className="de-field-hint">{t("采纳后形成该客户的正式行动，不会创建客群活动。")}</p>
        <div className="de-modal-actions">
          <button type="button" className="de-secondary-button" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="de-primary-button">{t("采纳并创建行动")}</button>
        </div>
      </form>
    </DialogFrame>
  );
}

export function SnoozeDialog({ onClose, onSave }: { onClose: () => void; onSave: (value: string) => void }) {
  const { t } = useI18n();
  const tomorrow = new Date(Date.now() + 86_400_000); const [value, setValue] = useState(tomorrow.toISOString().slice(0, 10));
  return (
    <DialogFrame title={t("稍后处理")} onClose={onClose}>
      <form
        className="de-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(new Date(`${value}T09:00:00`).toISOString());
        }}
      >
        <label>
          <span>{t("恢复日期")}</span>
          <input type="date" min={new Date().toISOString().slice(0, 10)} value={value} onChange={(event) => setValue(event.target.value)} required />
        </label>
        <p className="de-field-hint">{t("确认后会出现在「稍后处理」队列，可随时提前恢复；到期后自动回到“待判断”。")}</p>
        <div className="de-modal-actions">
          <button type="button" className="de-secondary-button" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="de-primary-button">{t("确认稍后")}</button>
        </div>
      </form>
    </DialogFrame>
  );
}

export function DismissDialog({ onClose, onSave }: { onClose: () => void; onSave: (value: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  return (
    <DialogFrame title={t("忽略商机")} onClose={onClose}>
      <form
        className="de-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(reason);
        }}
      >
        <label>
          <span>{t("选择一个原因")}</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)} required>
            <option value="">{t("请选择")}</option>
            {DISMISS_REASONS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        {reason === "信息不准确" && <p className="de-field-hint">{t("确认后将打开客户画像，方便纠正事实。")}</p>}
        <div className="de-modal-actions">
          <button type="button" className="de-secondary-button" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="de-danger-button">{t("忽略")}</button>
        </div>
      </form>
    </DialogFrame>
  );
}

export function RescheduleDialog({ item, onClose, onSave }: { item: OpportunityItem; onClose: () => void; onSave: (value: string) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(localInput(item.scheduledAt || new Date().toISOString()));
  return (
    <DialogFrame title={t("调整跟进时间")} onClose={onClose}>
      <form
        className="de-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(new Date(value).toISOString());
        }}
      >
        <label>
          <span>{t("新的计划时间")}</span>
          <input type="datetime-local" value={value} onChange={(event) => setValue(event.target.value)} required />
        </label>
        <div className="de-modal-actions">
          <button type="button" className="de-secondary-button" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="de-primary-button">{t("保存")}</button>
        </div>
      </form>
    </DialogFrame>
  );
}

export function ResultDialog({ item, onClose, onSave }: { item: OpportunityItem; onClose: () => void; onSave: (value: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState("");
  const [quote, setQuote] = useState("");
  const [note, setNote] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextAt, setNextAt] = useState("");
  const [stage, setStage] = useState("");
  return (
    <DialogFrame title={t("回填结果 · {0}", [item.customerName])} onClose={onClose}>
      <form
        className="de-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            outcome,
            customerQuote: quote || undefined,
            note: note || undefined,
            nextAction: nextAction || undefined,
            nextActionAt: nextAt ? new Date(nextAt).toISOString() : undefined,
            confirmedRelationshipStage: stage || undefined,
          });
        }}
      >
        <fieldset className="de-result-options">
          <legend>{t("本次结果")}</legend>
          {Object.entries(OUTCOME_LABELS).map(([value, label]) => (
            <label key={value} className={outcome === value ? "active" : ""}>
              <input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} required />
              <span>{t(label)}</span>
            </label>
          ))}
        </fieldset>
        <div className="de-form-grid">
          <label>
            <span>{t("客户原话（选填）")}</span>
            <textarea value={quote} onChange={(e) => setQuote(e.target.value)} />
          </label>
          <label>
            <span>{t("补充说明（选填）")}</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label>
            <span>{t("下一步行动")}</span>
            <input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder={t("有下一步时填写")} />
          </label>
          <label>
            <span>{t("预计时间")}</span>
            <input type="datetime-local" value={nextAt} onChange={(event) => setNextAt(event.target.value)} required={Boolean(nextAction)} />
          </label>
          <label>
            <span>{t("确认更新客户阶段")}</span>
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">{t("暂不更新")}</option>
              {Object.entries(RELATIONSHIP_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {t(l)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="de-modal-actions">
          <button type="button" className="de-secondary-button" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="de-primary-button">{t("保存结果")}</button>
        </div>
      </form>
    </DialogFrame>
  );
}

export function CreateActionDialog({ onClose, onSave }: { onClose: () => void; onSave: (input: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [profiles, setProfiles] = useState<Array<{ id: string; displayName: string; organization: string | null }>>([]);
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [opportunityType, setOpportunityType] = useState<OpportunityType>("event_invitation");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [method, setMethod] = useState("企微/微信");
  const [priority, setPriority] = useState("normal");
  const [scheduledAt, setScheduledAt] = useState(localInput(new Date().toISOString()));
  const [criteria, setCriteria] = useState("获得有效回复或下一步");
  const [productName, setProductName] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) { setProfiles([]); return; }
    const id = window.setTimeout(async () => {
      setSearching(true);
      try {
        const resp = await employeeApi.listCustomerProfiles({ q: query, limit: 8 });
        setProfiles(resp.items.map((p) => ({ id: p.id, displayName: p.displayName, organization: p.organization })));
      } catch { setProfiles([]); } finally { setSearching(false); }
    }, 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const pickProfile = (id: string, name: string) => {
    setProfileId(id);
    setProfileName(name);
    setQuery("");
    setProfiles([]);
    setProfileError(null);
  };

  const clearProfile = () => {
    setProfileId("");
    setProfileName("");
    setProfileError(null);
  };

  return <DialogFrame title={t("手动添加跟进行动")} onClose={onClose}>
    <form className="de-form" onSubmit={(e) => {
      e.preventDefault();
      if (!profileId.trim()) {
        setProfileError("请从搜索结果中选择一位客户后再创建");
        return;
      }
      onSave({ profileId, opportunityType, title, objective, followUpMethod: method, priority,
        scheduledAt: new Date(scheduledAt).toISOString(), resultCriteria: criteria || undefined,
        productName: productName || undefined });
    }}>
      <div className="de-form-grid">
        <label className="de-form-full"><span>{t("客户")}</span>
          {profileId ? (
            <div className="de-selected-profile" data-profile-id={profileId}>
              <div>
                <strong>{profileName}</strong>
                <small>{t("已绑定客户画像")}</small>
              </div>
              <button type="button" className="de-quiet-button" onClick={clearProfile}>{t("更换")}</button>
            </div>
          ) : (
            <div className="de-profile-search">
              <input
                placeholder={t("输入客户姓名搜索并选择")}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setProfileError(null); }}
                autoComplete="off"
                aria-autocomplete="list"
                aria-expanded={profiles.length > 0}
                aria-controls="de-create-action-profile-options"
              />
              {searching && <small className="de-profile-search-status">{t("搜索中…")}</small>}
              {!searching && query.trim() && profiles.length === 0 && (
                <small className="de-profile-search-status">{t("未找到匹配客户，请换个关键词")}</small>
              )}
              {profiles.length > 0 && <ul id="de-create-action-profile-options" className="de-profile-dropdown" role="listbox">
                {profiles.map((p) => (
                  <li key={p.id} role="option">
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickProfile(p.id, p.displayName)}
                    >
                      <span>{p.displayName}</span>
                      {p.organization && <small>{p.organization}</small>}
                    </button>
                  </li>
                ))}
              </ul>}
            </div>
          )}
          {profileError && <p className="de-field-error" role="alert">{t(profileError)}</p>}
          {!profileId && !profileError && <p className="de-field-hint">{t("必须点选搜索结果中的客户，仅输入姓名不会绑定画像。")}</p>}
        </label>
        <label><span>{t("机会类型")}</span>
          <select value={opportunityType} onChange={(e) => setOpportunityType(e.target.value as OpportunityType)}>
            {FIRST_TYPES.map((v) => <option key={v} value={v}>{t(OPPORTUNITY_TYPE_LABELS[v])}</option>)}
          </select>
        </label>
        <label><span>{t("优先级")}</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="high">{t("高")}</option><option value="normal">{t("中")}</option><option value="low">{t("低")}</option>
          </select>
        </label>
        <label className="de-form-full"><span>{t("行动标题")}</span><input value={t(title)} onChange={(e) => setTitle(e.target.value)} required /></label>
        <label className="de-form-full"><span>{t("跟进目标")}</span><textarea value={objective} onChange={(e) => setObjective(e.target.value)} required /></label>
        <label><span>{t("沟通方式")}</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>{t("企微/微信")}</option><option>{t("电话")}</option><option>{t("邮件")}</option><option>{t("线下拜访")}</option>
          </select>
        </label>
        <label><span>{t("计划时间")}</span><input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required /></label>
        <label><span>{t("结果口径（选填）")}</span><input value={criteria} onChange={(e) => setCriteria(e.target.value)} /></label>
        <label><span>{t("关联产品（选填）")}</span><input value={productName} onChange={(e) => setProductName(e.target.value)} /></label>
      </div>
      <div className="de-modal-actions">
        <button type="button" className="de-secondary-button" onClick={onClose}>{t("取消")}</button>
        <button type="submit" className="de-primary-button" disabled={!profileId} title={!profileId ? t("请先选择客户") : undefined}>{t("创建行动")}</button>
      </div>
    </form>
  </DialogFrame>;
}

function localInput(value: string) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
