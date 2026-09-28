import { useI18n } from "../../../i18n/index.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { ModelPicker } from "../../../components/ModelPicker.js";
import { shouldSubmitComposer } from "../../../lib/composer-keyboard.js";
import type { CatalogModel } from "../../../lib/model-filter.js";
import {
  OPPORTUNITY_TYPE_LABELS, OUTCOME_LABELS, READINESS_LABELS, RELATIONSHIP_LABELS,
  type OpportunityItem, type OpportunityListResponse, type OpportunitySettings,
  type OpportunityType, type OpportunityView, type TalkTrackIntent, type TalkTrackMessage,
} from "../types.js";

interface Props {
  llmModels: CatalogModel[];
  onOpenProfile: (id: string) => void;
  onCreateProfile: () => void;
  onOpenChat?: () => void;
}

const VIEWS: Array<{ id: OpportunityView; label: string }> = [
  { id: "today", label: "今日经营" },
  { id: "pending", label: "待判断" },
  { id: "snoozed", label: "稍后处理" },
  { id: "in_progress", label: "跟进中" },
  { id: "awaiting_result", label: "待回填" },
  { id: "completed", label: "已完成" },
];
const PRIORITY_LABELS = { high: "高优先", normal: "中优先", low: "低优先" } as const;
const FIRST_TYPES: OpportunityType[] = ["prospect_progress", "silent_reengage", "event_invitation", "renewal", "risk_recovery"];
const DISMISS_REASONS = ["当前不合适", "已经处理", "客户明确拒绝", "信息不准确", "不再跟进"];
type FilterValues = { readiness: string; priority: string; opportunityType: string; relationshipStage: string; product: string; suggestedFrom: string; suggestedTo: string };

export function OpportunityAdvisorPage({ llmModels, onOpenProfile, onCreateProfile, onOpenChat }: Props) {
  const { t } = useI18n();
  const [view, setView] = useState<OpportunityView>("today");
  const [data, setData] = useState<OpportunityListResponse | null>(null);
  const [filters, setFilters] = useState<FilterValues>({ readiness: "", priority: "", opportunityType: "", relationshipStage: "", product: "", suggestedFrom: "", suggestedTo: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverProgress, setDiscoverProgress] = useState(0);
  const [discoverNotice, setDiscoverNotice] = useState<string | null>(null);
  const [active, setActive] = useState<OpportunityItem | null>(null);
  const [dialog, setDialog] = useState<"accept" | "snooze" | "dismiss" | "reschedule" | "result" | "create" | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await api.listOpportunities({ view, ...filters })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "商机加载失败"); }
    finally { setLoading(false); }
  }, [view, filters]);
  useEffect(() => { void load(); }, [load]);

  const discover = async () => {
    if (discovering) return;
    setDiscovering(true); setDiscoverProgress(2); setError(null); setDiscoverNotice(null);
    try {
      const { taskId } = await api.discoverOpportunities();
      let createdCount: number | null = null;
      for (;;) {
        const task = await api.getTask(taskId);
        setDiscoverProgress(task.progress);
        if (task.status === "succeeded") {
          const raw = task.output?.created;
          const parsed = typeof raw === "number" ? raw : Number(raw);
          createdCount = Number.isFinite(parsed) ? parsed : null;
          break;
        }
        if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error || "商机发现未完成");
        await new Promise((resolve) => window.setTimeout(resolve, 800));
      }
      setView("pending");
      await load();
      if (createdCount != null && createdCount > 0) {
        setDiscoverNotice(`发现了 ${createdCount} 条新商机，已刷新「待判断」列表`);
      } else {
        setDiscoverNotice("暂无新商机（已有建议可能因去重未重复创建）");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "商机发现失败"); }
    finally { setDiscovering(false); setDiscoverProgress(0); }
  };

  const saveSettings = async (settings: OpportunitySettings) => {
    setSavingSettings(true); setError(null);
    try {
      const saved = await api.saveOpportunitySettings(settings);
      setData((current) => current ? { ...current, settings: saved } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "自动发现设置保存失败"); }
    finally { setSavingSettings(false); }
  };

  const openDialog = (item: OpportunityItem, next: typeof dialog) => { setActive(item); setDialog(next); };
  const closeDialog = () => { setDialog(null); setActive(null); };
  const mutate = async (operation: () => Promise<unknown>) => {
    setError(null);
    try { await operation(); closeDialog(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
  };

  const counts = useMemo(() => data?.summary.viewCounts, [data]);

  return (
    <div className="de-page de-opportunity-page">
      <header className="de-opportunity-header">
        <div>
          <p className="de-eyebrow">{t("数字员工 / 商机雷达")}</p>
          <h1>{t("商机雷达")}</h1>
          <p>{t("盯住每个客户：今天该联系谁、为什么、下一步做什么。")}</p>
        </div>
        <div className="de-opportunity-header-actions">
          {onOpenChat && (
            <button type="button" className="de-secondary-button" onClick={onOpenChat}>
              {t("与商机雷达对话")}</button>
          )}
          <button className="de-primary-button" disabled={discovering} onClick={() => void discover()}>
            {discovering ? t("发现中 {0}%", [discoverProgress]) : t("✦ 发现新商机")}
          </button>
          <button className="de-secondary-button" onClick={() => { setActive(null); setDialog("create"); }}>{t("手动添加行动")}</button>
        </div>
      </header>

      {data && <Summary summary={data.summary} />}
      {data && <Automation settings={data.settings} lastDiscoveredAt={data.lastDiscoveredAt} saving={savingSettings} onSave={saveSettings} />}
      {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span><button onClick={() => setError(null)}>{t("关闭")}</button></div>}
      {discoverNotice && <div className="de-inline-notice" role="status"><span>{t(discoverNotice)}</span><button onClick={() => setDiscoverNotice(null)}>{t("关闭")}</button></div>}

      <div className="de-opportunity-tabs" role="tablist">
        {VIEWS.map((item) => <button key={item.id} role="tab" aria-selected={view === item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
          {t(item.label)}{counts && <b>{counts[item.id]}</b>}
        </button>)}
      </div>

      <Filters values={filters} onChange={setFilters} />

      {loading ? <div className="de-state">{t("正在读取客户经营事项…")}</div> : !data?.items.length ? (
        <Empty view={view} hasProfiles={data?.hasProfiles ?? false} hasFilters={Object.values(filters).some(Boolean)} onCreateProfile={onCreateProfile} onDiscover={() => void discover()} />
      ) : (
        <section className="de-opportunity-list" aria-label={VIEWS.find((item) => item.id === view)?.label}>
          {data.items.map((item) => <OpportunityCard key={item.id} item={item} llmModels={llmModels} onOpenProfile={onOpenProfile} onAction={openDialog}
            onResume={() => void mutate(() => api.decideOpportunity(item.opportunityId, { decision: "resume" }))}
            onExecute={() => void mutate(() => api.updateOpportunityAction(item.actionId!, { operation: "execute", version: item.actionVersion }))}
            onCancel={() => void mutate(() => api.updateOpportunityAction(item.actionId!, { operation: "cancel", reason: "user_cancelled", version: item.actionVersion }))} />)}
        </section>
      )}

      {active && dialog === "accept" && <AcceptDialog item={active} onClose={closeDialog} onSave={(input) => void mutate(() =>
        api.decideOpportunity(active.opportunityId, { decision: "accept", ...input })
      )} />}
      {active && dialog === "snooze" && <SnoozeDialog onClose={closeDialog} onSave={(snoozedUntil) => {
        void (async () => {
          setError(null);
          try {
            await api.decideOpportunity(active.opportunityId, { decision: "snooze", snoozedUntil });
            closeDialog();
            setView("snoozed");
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "操作失败");
          }
        })();
      }} />}
      {active && dialog === "dismiss" && <DismissDialog onClose={closeDialog} onSave={(reason) => {
        if (reason === "信息不准确") {
          const profileId = active.profileId;
          void mutate(() => api.decideOpportunity(active.opportunityId, { decision: "dismiss", reason })).then(() => onOpenProfile(profileId));
          return;
        }
        void mutate(() => api.decideOpportunity(active.opportunityId, { decision: "dismiss", reason }));
      }} />}
      {active && dialog === "reschedule" && <RescheduleDialog item={active} onClose={closeDialog} onSave={(scheduledAt) => void mutate(() => api.updateOpportunityAction(active.actionId!, { operation: "reschedule", scheduledAt, version: active.actionVersion }))} />}
      {active && dialog === "result" && <ResultDialog item={active} onClose={closeDialog} onSave={(input) => void mutate(() => api.addOpportunityActionResult(active.actionId!, input))} />}
      {dialog === "create" && <CreateActionDialog onClose={closeDialog} onSave={(input) => void mutate(async () => { await api.createOpportunityAction(input); setView("in_progress"); })} />}
    </div>
  );
}

function Summary({ summary }: { summary: OpportunityListResponse["summary"] }) {
  const { t } = useI18n();
  return <section className="de-opportunity-summary" aria-label={t("商机汇总")}>
    <div><span>{t("今日待跟进")}</span><strong>{summary.dueToday}</strong></div>
    <div className="overdue"><span>{t("逾期行动")}</span><strong>{summary.overdue}</strong></div>
    <div className="high"><span>{t("高优先新商机")}</span><strong>{summary.highPriority}</strong></div>
    <div><span>{t("待回填结果")}</span><strong>{summary.awaitingResult}</strong></div>
  </section>;
}

function Automation({ settings, lastDiscoveredAt, saving, onSave }: { settings: OpportunitySettings; lastDiscoveredAt: string | null; saving: boolean; onSave: (value: OpportunitySettings) => void }) {
  const { t, locale } = useI18n();
  return <section className="de-opportunity-automation">
    <span>{t("最近发现：")}<strong>{lastDiscoveredAt ? formatTime(lastDiscoveredAt, locale) : t("尚未运行")}</strong></span>
    <label className="de-switch"><input type="checkbox" checked={settings.enabled} disabled={saving} onChange={(event) => onSave({ ...settings, enabled: event.target.checked })} /><i /><span>{t("每日自动发现")}</span></label>
    <label><span>{t("执行时间")}</span><input type="time" value={settings.dailyRunTime} disabled={!settings.enabled || saving} onChange={(event) => onSave({ ...settings, dailyRunTime: event.target.value })} /></label>
    <small>{settings.enabled && settings.nextRunAt ? t("下次 {0}", [formatTime(settings.nextRunAt, locale)]) : t("默认关闭，不会产生模型费用")}</small>
  </section>;
}

function Filters({ values, onChange }: { values: FilterValues; onChange: (value: FilterValues) => void }) {
  const { t } = useI18n();
  const field = (key: string, value: string) => onChange({ ...values, [key]: value });
  return <section className="de-filter-card de-opportunity-filters" aria-label={t("商机筛选")}>
    <label className="de-filter-select"><span>{t("准备度")}</span><select value={values.readiness} onChange={(e) => field("readiness", e.target.value)}><option value="">{t("全部")}</option>{Object.entries(READINESS_LABELS).map(([v,l]) => <option key={v} value={v}>{t(l)}</option>)}</select></label>
    <label className="de-filter-select"><span>{t("优先级")}</span><select value={values.priority} onChange={(e) => field("priority", e.target.value)}><option value="">{t("全部")}</option><option value="high">{t("高")}</option><option value="normal">{t("中")}</option><option value="low">{t("低")}</option></select></label>
    <label className="de-filter-select"><span>{t("机会类型")}</span><select value={values.opportunityType} onChange={(e) => field("opportunityType", e.target.value)}><option value="">{t("全部")}</option>{FIRST_TYPES.map((v) => <option key={v} value={v}>{t(OPPORTUNITY_TYPE_LABELS[v])}</option>)}</select></label>
    <label className="de-filter-select"><span>{t("客户阶段")}</span><select value={values.relationshipStage} onChange={(e) => field("relationshipStage", e.target.value)}><option value="">{t("全部")}</option>{Object.entries(RELATIONSHIP_LABELS).map(([v,l]) => <option key={v} value={v}>{t(l)}</option>)}</select></label>
    <label className="de-filter-select de-opportunity-product-filter"><span>{t("产品")}</span><input placeholder={t("产品名称")} value={values.product} onChange={(e) => field("product", e.target.value)} /></label>
    <label className="de-filter-select"><span>{t("发现自")}</span><input type="date" value={values.suggestedFrom} onChange={(e) => field("suggestedFrom", e.target.value)} /></label>
    <label className="de-filter-select"><span>{t("发现至")}</span><input type="date" value={values.suggestedTo} onChange={(e) => field("suggestedTo", e.target.value)} /></label>
    {Object.values(values).some(Boolean) && <button className="de-quiet-button" onClick={() => onChange({ readiness: "", priority: "", opportunityType: "", relationshipStage: "", product: "", suggestedFrom: "", suggestedTo: "" })}>{t("清除筛选")}</button>}
  </section>;
}

function OpportunityCard({ item, llmModels, onOpenProfile, onAction, onResume, onExecute, onCancel }: {
  item: OpportunityItem; llmModels: CatalogModel[]; onOpenProfile: (id: string) => void;
  onAction: (item: OpportunityItem, action: "accept" | "snooze" | "dismiss" | "reschedule" | "result") => void;
  onResume: () => void; onExecute: () => void; onCancel: () => void;
}) {
  const { t, locale } = useI18n();
  const [talkOpen, setTalkOpen] = useState(false);
  const blocked = item.riskFlags.some((risk) => risk.blocking);
  return <article className={`de-opportunity-card priority-${item.priority} ${item.overdue ? "is-overdue" : ""} ${blocked ? "is-blocked" : ""} ${talkOpen ? "has-talk-track" : ""}`}>
    <header>
      <div className="de-opportunity-identity">
        <button className="de-opportunity-customer" onClick={() => onOpenProfile(item.profileId)}><span>{item.customerName.slice(0, 1)}</span><strong>{item.customerName}<small>{item.organization || t(RELATIONSHIP_LABELS[item.relationshipStage])}</small></strong></button>
        <button type="button" className={`de-talk-track-toggle${talkOpen ? " is-open" : ""}`} aria-expanded={talkOpen} onClick={() => setTalkOpen((value) => !value)}>
          <span aria-hidden="true">✦</span>{t("联系话术")}</button>
      </div>
      <div className="de-opportunity-badges"><i className={`source-${item.source}`}>{item.source === "manual" ? t("确定提醒") : t("AI 商机")}</i><span>{t(OPPORTUNITY_TYPE_LABELS[item.opportunityType])}</span><b className={`priority-${item.priority}`}>{t(PRIORITY_LABELS[item.priority])}</b><em>{t(READINESS_LABELS[item.readiness])}</em></div>
    </header>
    <TalkTrackAssistant item={item} open={talkOpen} llmModels={llmModels} onClose={() => setTalkOpen(false)} />
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
            <span>{t("沟通方式：")}{item.followUpMethod || t("根据客户偏好")}</span>
            {item.productName && <span>{t("关联产品：")}{item.productName}</span>}
          </div>
        </section>
        <section className="de-opportunity-section">
          <h3>{t("为什么现在")}</h3>
          <ul>{item.evidence.map((evidence, index) => <li key={`${evidence.sourceId ?? evidence.sourceType}-${index}`}><time>{shortDate(evidence.occurredAt, locale)}</time><span>{evidence.fact}</span></li>)}</ul>
        </section>
        {item.riskFlags.map((risk) => <div key={risk.code} className={`de-opportunity-risk ${risk.blocking ? "blocking" : ""}`}>⚠ {risk.message}</div>)}
        {(item.view === "snoozed" || item.snoozedUntil) && item.view !== "pending" && (
          <div className="de-opportunity-later-trail">
            <strong>{t("稍后处理轨迹")}</strong>
            <span>{item.decisionReason || t("已标记稍后处理")}</span>
            {item.snoozedUntil && <time>{t("恢复：")}{formatTime(item.snoozedUntil, locale)}</time>}
            {item.updatedAt && <small>{t("记录于")}{formatTime(item.updatedAt, locale)}</small>}
          </div>
        )}
      </div>
      <aside className="de-opportunity-task-aside">
        <span>{t("可一键任务")}</span>
        <strong>{item.view === "pending" || item.view === "snoozed" ? t("采纳后生成跟进任务") : item.view === "in_progress" ? t("执行中的跟进任务") : item.view === "awaiting_result" ? t("待回填结果") : t("任务结果")}</strong>
        <p>{item.view === "snoozed" && item.snoozedUntil ? t("稍后至 {0}", [formatTime(item.snoozedUntil, locale)]) : item.scheduledAt ? formatTime(item.scheduledAt, locale) : formatTime(item.suggestedAt, locale)}</p>
        {item.resultCriteria && <small>{t("成功口径：")}{item.resultCriteria}</small>}
        {!item.resultCriteria && <small>{t("成功口径：获得有效回复或明确下一步")}</small>}
        {item.productName && <small>{t("关联：")}{item.productName}</small>}
      </aside>
    </div>
    <footer>
      {item.view === "pending" && <><button className="de-primary-button" disabled={blocked} onClick={() => onAction(item, "accept")}>{t("采纳并确认行动")}</button><button className="de-secondary-button" onClick={() => onAction(item, "snooze")}>{t("稍后")}</button><button className="de-quiet-button" onClick={() => onAction(item, "dismiss")}>{t("忽略")}</button></>}
      {item.view === "snoozed" && <><button className="de-primary-button" onClick={onResume}>{t("提前恢复")}</button><button className="de-secondary-button" disabled={blocked} onClick={() => onAction(item, "accept")}>{t("采纳并确认行动")}</button><button className="de-quiet-button" onClick={() => onAction(item, "dismiss")}>{t("忽略")}</button></>}
      {item.view === "in_progress" && <><button className="de-primary-button" onClick={onExecute}>{t("标记已执行")}</button><button className="de-secondary-button" onClick={() => onAction(item, "reschedule")}>{t("改时间")}</button><button className="de-quiet-button" onClick={onCancel}>{t("取消")}</button></>}
      {item.view === "awaiting_result" && <button className="de-primary-button" onClick={() => onAction(item, "result")}>{t("回填结果")}</button>}
      {item.view === "completed" && <><span className="de-opportunity-outcome">{item.closeReason === "overdue_closed" ? t("已逾期关闭") : t(OUTCOME_LABELS[item.outcome ?? ""]) || t("已取消")}</span>{item.customerQuote && <q>{item.customerQuote}</q>}</>}
      <button className="de-opportunity-profile-link" onClick={() => onOpenProfile(item.profileId)}>{t("查看画像与来源 →")}</button>
    </footer>
  </article>;
}

const TALK_TRACK_PRESETS: Array<{ intent: TalkTrackIntent; label: string; prompt: string }> = [
  { intent: "maintenance", label: "维护问候", prompt: "请生成一段自然、不带强推销感的客户维护问候话术。" },
  { intent: "follow_up", label: "跟进联络", prompt: "请根据当前事项生成一段可直接发送的跟进联络话术，明确但不要给客户压力。" },
  { intent: "sales", label: "产品推介", prompt: "请结合客户需求和已核实的产品资料，生成一段有针对性的产品推介话术。" },
];

function TalkTrackAssistant({ item, open, llmModels, onClose }: { item: OpportunityItem; open: boolean; llmModels: CatalogModel[]; onClose: () => void }) {
  const { t } = useI18n();
  const compositionActiveRef = useRef(false);
  const [intent, setIntent] = useState<TalkTrackIntent>("follow_up");
  const [messages, setMessages] = useState<TalkTrackMessage[]>([]);
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveModel = selectedModel && llmModels.some((model) => model.id === selectedModel)
    ? selectedModel
    : llmModels[0]?.id ?? null;

  const send = async (content: string, nextIntent: TalkTrackIntent = intent) => {
    const message = content.trim();
    if (!message || loading || !effectiveModel) return;
    const history = messages.slice(-12);
    setIntent(nextIntent);
    setMessages((current) => [...current, { role: "user", content: message }]);
    setInput(""); setLoading(true); setError(null);
    try {
      const result = await api.generateOpportunityTalkTrack(item.id, { intent: nextIntent, message, history, modelId: effectiveModel });
      setMessages((current) => [...current, { role: "assistant", content: result.reply }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "话术生成失败，请重试");
    } finally { setLoading(false); }
  };

  if (!open) return null;
  return <section className="de-talk-track-panel" aria-label={t("{0}联系话术助手", [item.customerName])}>
      <header><div><strong>{t("单客户话术助手")}</strong><span>{t("已带入")}{item.customerName} {t("的画像、当前事项")}{item.productName ? t("和{0}资料", [item.productName]) : ""}</span></div><button type="button" onClick={onClose} aria-label={t("收起话术助手")}>×</button></header>
      <div className="de-talk-track-presets">
        {TALK_TRACK_PRESETS.map((preset) => <button type="button" key={preset.intent} disabled={loading || !effectiveModel} className={intent === preset.intent ? "active" : ""} onClick={() => void send(preset.prompt, preset.intent)}>{t(preset.label)}</button>)}
      </div>
      {messages.length === 0 && <div className="de-talk-track-empty"><span>✦</span><p>{t("选择一种场景直接生成，或在下方说明渠道、语气和想达到的目的。")}</p></div>}
      {messages.length > 0 && <div className="de-talk-track-messages">
        {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`de-talk-track-message ${message.role}`}>
          <span>{message.role === "assistant" ? t("参谋") : t("你")}</span><p>{message.content}</p>
          {message.role === "assistant" && <button type="button" onClick={() => void navigator.clipboard.writeText(message.content)}>{t("复制")}</button>}
        </div>)}
        {loading && <div className="de-talk-track-thinking"><i /><span>{t("正在结合客户信息生成…")}</span></div>}
      </div>}
      {error && <p className="de-talk-track-error" role="alert">{t(error)}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void send(input); }}>
        <div className="de-talk-track-composer">
          <textarea value={input} maxLength={2_000} rows={2} disabled={loading || !effectiveModel} placeholder={effectiveModel ? t("例如：语气更熟悉一点，适合微信，先询问对方是否方便……") : t("平台暂未返回可用的 LLM 模型")} onChange={(event) => setInput(event.target.value)} onCompositionStart={() => { compositionActiveRef.current = true; }} onCompositionEnd={() => { compositionActiveRef.current = false; }} onKeyDown={(event) => {
            if (shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, compositionActiveRef.current)) { event.preventDefault(); void send(input); }
          }} />
          <div className="de-talk-track-composer-toolbar">
            <span>{t("当前 Key 模型")}</span>
            <ModelPicker models={llmModels} value={effectiveModel} onChange={setSelectedModel} disabled={loading} />
          </div>
        </div>
        <button type="submit" className="de-primary-button" disabled={loading || !effectiveModel || !input.trim()}>{loading ? t("生成中") : t("发送")}</button>
      </form>
      <small>{t("AI 话术仅供参考，发送前请核对客户事实、产品承诺和价格权益。")}</small>
    </section>;
}

function Empty({ view, hasProfiles, hasFilters, onCreateProfile, onDiscover }: { view: OpportunityView; hasProfiles: boolean; hasFilters: boolean; onCreateProfile: () => void; onDiscover: () => void }) {
  const { t } = useI18n();
  const content = !hasProfiles ? ["还没有可经营的客户画像", "商机雷达只围绕已建档的单个客户工作，请先建立客户画像。"] : hasFilters ? ["没有符合筛选条件的客户事项", "清除或调整筛选条件后再看。"] : view === "today" ? ["今天没有必须处理的客户事项", "可以查看待判断商机，或手动安排一次回访和维护。"] : view === "pending" ? ["当前没有需要判断的新商机", "可以立即运行一次发现；确定性提醒仍会按计划出现在今日经营。"] : view === "snoozed" ? ["稍后处理队列为空", "在「待判断」里点「稍后」的商机会出现在这里，到期后自动回到待判断。"] : ["这个视图目前为空", "行动采纳、执行和结果回填后会自动流转到对应视图。"];
  return <div className="de-state de-empty-state de-opportunity-empty"><span className="de-empty-icon">◇</span><strong>{t(content[0])}</strong><p>{t(content[1])}</p>{!hasProfiles ? <button className="de-primary-button" onClick={onCreateProfile}>{t("新建客户")}</button> : view === "pending" && <button className="de-secondary-button" onClick={onDiscover}>{t("发现新商机")}</button>}</div>;
}

function DialogFrame({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const { t } = useI18n();
  return <div className="de-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="de-modal de-opportunity-dialog" role="dialog" aria-modal="true"><header className="de-modal-head"><div><h2>{t(title)}</h2></div><button className="de-icon-button" onClick={onClose}>×</button></header>{children}</section></div>;
}

function AcceptDialog({ item, onClose, onSave }: { item: OpportunityItem; onClose: () => void; onSave: (input: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const [objective, setObjective] = useState(item.objective); const [method, setMethod] = useState(item.followUpMethod || "企微/微信");
  const [scheduledAt, setScheduledAt] = useState(localInput(item.scheduledAt || item.suggestedAt)); const [criteria, setCriteria] = useState(item.resultCriteria || "获得有效回复或下一步");
  return <DialogFrame title={t("确认跟进行动")} onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave({ objective, followUpMethod: method, scheduledAt: new Date(scheduledAt).toISOString(), resultCriteria: criteria }); }}>
    <div className="de-dialog-context"><strong>{item.customerName} · {t(OPPORTUNITY_TYPE_LABELS[item.opportunityType])}</strong><p>{item.reason}</p></div>
    <div className="de-form-grid"><label><span>{t("推荐目标")}</span><textarea value={objective} onChange={(e) => setObjective(e.target.value)} required /></label><label><span>{t("结果口径")}</span><textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} required /></label><label><span>{t("沟通方式")}</span><select value={method} onChange={(e) => setMethod(e.target.value)}><option>{t("企微/微信")}</option><option>{t("电话")}</option><option>{t("邮件")}</option><option>{t("线下拜访")}</option></select></label><label><span>{t("计划时间")}</span><input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required /></label></div>
    <p className="de-field-hint">{t("采纳后形成该客户的正式行动，不会创建客群营销项目；单客户联系话术将在商机雷达内继续准备。")}</p>
    <div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>{t("取消")}</button><button className="de-primary-button">{t("采纳并创建行动")}</button></div>
  </form></DialogFrame>;
}

function SnoozeDialog({ onClose, onSave }: { onClose: () => void; onSave: (value: string) => void }) {
  const { t } = useI18n();
  const tomorrow = new Date(Date.now() + 86_400_000); const [value, setValue] = useState(tomorrow.toISOString().slice(0, 10));
  return <DialogFrame title={t("稍后处理")} onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave(new Date(`${value}T09:00:00`).toISOString()); }}><label><span>{t("恢复日期")}</span><input type="date" min={new Date().toISOString().slice(0,10)} value={value} onChange={(e) => setValue(e.target.value)} required /></label><p className="de-field-hint">{t("确认后会出现在「稍后处理」队列，可随时提前恢复；到期后自动回到“待判断”。")}</p><div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>{t("取消")}</button><button className="de-primary-button">{t("确认稍后")}</button></div></form></DialogFrame>;
}

function DismissDialog({ onClose, onSave }: { onClose: () => void; onSave: (value: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  return <DialogFrame title={t("忽略商机")} onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave(reason); }}><label><span>{t("选择一个原因")}</span><select value={reason} onChange={(e) => setReason(e.target.value)} required><option value="">{t("请选择")}</option>{DISMISS_REASONS.map((item) => <option key={item}>{item}</option>)}</select></label>{reason === "信息不准确" && <p className="de-field-hint">{t("确认后将打开客户画像，方便纠正事实。")}</p>}<div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>{t("取消")}</button><button className="de-danger-button">{t("忽略")}</button></div></form></DialogFrame>;
}

function RescheduleDialog({ item, onClose, onSave }: { item: OpportunityItem; onClose: () => void; onSave: (value: string) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(localInput(item.scheduledAt || new Date().toISOString()));
  return <DialogFrame title={t("调整跟进时间")} onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave(new Date(value).toISOString()); }}><label><span>{t("新的计划时间")}</span><input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} required /></label><div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>{t("取消")}</button><button className="de-primary-button">{t("保存")}</button></div></form></DialogFrame>;
}

function ResultDialog({ item, onClose, onSave }: { item: OpportunityItem; onClose: () => void; onSave: (value: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState(""); const [quote, setQuote] = useState(""); const [note, setNote] = useState(""); const [nextAction, setNextAction] = useState(""); const [nextAt, setNextAt] = useState(""); const [stage, setStage] = useState("");
  return <DialogFrame title={t("回填结果 · {0}", [item.customerName])} onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave({ outcome, customerQuote: quote || undefined, note: note || undefined, nextAction: nextAction || undefined, nextActionAt: nextAt ? new Date(nextAt).toISOString() : undefined, confirmedRelationshipStage: stage || undefined }); }}>
    <fieldset className="de-result-options"><legend>{t("本次结果")}</legend>{Object.entries(OUTCOME_LABELS).map(([value,label]) => <label key={value} className={outcome === value ? "active" : ""}><input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} required /><span>{t(label)}</span></label>)}</fieldset>
    <div className="de-form-grid"><label><span>{t("客户原话（选填）")}</span><textarea value={quote} onChange={(e) => setQuote(e.target.value)} /></label><label><span>{t("补充说明（选填）")}</span><textarea value={note} onChange={(e) => setNote(e.target.value)} /></label><label><span>{t("下一步行动")}</span><input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder={t("有下一步时填写")} /></label><label><span>{t("预计时间")}</span><input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} required={Boolean(nextAction)} /></label><label><span>{t("确认更新客户阶段")}</span><select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">{t("暂不更新")}</option>{Object.entries(RELATIONSHIP_LABELS).map(([v,l]) => <option key={v} value={v}>{t(l)}</option>)}</select></label></div>
    <div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>{t("取消")}</button><button className="de-primary-button">{t("保存结果")}</button></div>
  </form></DialogFrame>;
}

function formatTime(value: string, locale = "zh-CN") { const date = new Date(value); return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
function shortDate(value: string, locale = "zh-CN") { return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(new Date(value)); }
function localInput(value: string) { const date = new Date(value); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }

function CreateActionDialog({ onClose, onSave }: { onClose: () => void; onSave: (input: Record<string, unknown>) => void }) {
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
        const resp = await api.listCustomerProfiles({ q: query, limit: 8 });
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
        <label><span>{t("计划时间")}</span><input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required /></label>
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
