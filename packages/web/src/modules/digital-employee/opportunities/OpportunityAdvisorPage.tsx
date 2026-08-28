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
}

const VIEWS: Array<{ id: OpportunityView; label: string }> = [
  { id: "today", label: "今日经营" },
  { id: "pending", label: "待判断" }, { id: "in_progress", label: "跟进中" },
  { id: "awaiting_result", label: "待回填" }, { id: "completed", label: "已完成" },
];
const PRIORITY_LABELS = { high: "高优先", normal: "中优先", low: "低优先" } as const;
const FIRST_TYPES: OpportunityType[] = ["prospect_progress", "silent_reengage", "event_invitation", "renewal", "risk_recovery"];
const DISMISS_REASONS = ["当前不合适", "已经处理", "客户明确拒绝", "信息不准确", "不再跟进"];
type FilterValues = { readiness: string; priority: string; opportunityType: string; relationshipStage: string; product: string; suggestedFrom: string; suggestedTo: string };

export function OpportunityAdvisorPage({ llmModels, onOpenProfile, onCreateProfile }: Props) {
  const [view, setView] = useState<OpportunityView>("today");
  const [data, setData] = useState<OpportunityListResponse | null>(null);
  const [filters, setFilters] = useState<FilterValues>({ readiness: "", priority: "", opportunityType: "", relationshipStage: "", product: "", suggestedFrom: "", suggestedTo: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverProgress, setDiscoverProgress] = useState(0);
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
    setDiscovering(true); setDiscoverProgress(2); setError(null);
    try {
      const { taskId } = await api.discoverOpportunities();
      for (;;) {
        const task = await api.getTask(taskId);
        setDiscoverProgress(task.progress);
        if (task.status === "succeeded") break;
        if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error || "商机发现未完成");
        await new Promise((resolve) => window.setTimeout(resolve, 800));
      }
      setView("pending");
      await load();
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
          <p className="de-eyebrow">数字员工 / 商机雷达</p>
          <h1>商机雷达</h1>
          <p>盯住每个客户：今天该联系谁、为什么、下一步做什么。</p>
        </div>
        <div className="de-opportunity-header-actions">
          <button className="de-primary-button" disabled={discovering} onClick={() => void discover()}>
            {discovering ? `发现中 ${discoverProgress}%` : "✦ 发现新商机"}
          </button>
          <button className="de-secondary-button" onClick={() => { setActive(null); setDialog("create"); }}>手动添加行动</button>
        </div>
      </header>

      {data && <Summary summary={data.summary} />}
      {data && <Automation settings={data.settings} lastDiscoveredAt={data.lastDiscoveredAt} saving={savingSettings} onSave={saveSettings} />}
      {error && <div className="de-inline-error" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div>}

      <div className="de-opportunity-tabs" role="tablist">
        {VIEWS.map((item) => <button key={item.id} role="tab" aria-selected={view === item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
          {item.label}{counts && <b>{counts[item.id]}</b>}
        </button>)}
      </div>

      <Filters values={filters} onChange={setFilters} />

      {loading ? <div className="de-state">正在读取客户经营事项…</div> : !data?.items.length ? (
        <Empty view={view} hasProfiles={data?.hasProfiles ?? false} hasFilters={Object.values(filters).some(Boolean)} onCreateProfile={onCreateProfile} onDiscover={() => void discover()} />
      ) : (
        <section className="de-opportunity-list" aria-label={VIEWS.find((item) => item.id === view)?.label}>
          {data.items.map((item) => <OpportunityCard key={item.id} item={item} llmModels={llmModels} onOpenProfile={onOpenProfile} onAction={openDialog}
            onExecute={() => void mutate(() => api.updateOpportunityAction(item.actionId!, { operation: "execute", version: item.actionVersion }))}
            onCancel={() => void mutate(() => api.updateOpportunityAction(item.actionId!, { operation: "cancel", reason: "user_cancelled", version: item.actionVersion }))} />)}
        </section>
      )}

      {active && dialog === "accept" && <AcceptDialog item={active} onClose={closeDialog} onSave={(input) => void mutate(() =>
        api.decideOpportunity(active.opportunityId, { decision: "accept", ...input })
      )} />}
      {active && dialog === "snooze" && <SnoozeDialog onClose={closeDialog} onSave={(snoozedUntil) => void mutate(() => api.decideOpportunity(active.opportunityId, { decision: "snooze", snoozedUntil }))} />}
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
  return <section className="de-opportunity-summary" aria-label="商机汇总">
    <div><span>今日待跟进</span><strong>{summary.dueToday}</strong></div>
    <div className="overdue"><span>逾期行动</span><strong>{summary.overdue}</strong></div>
    <div className="high"><span>高优先新商机</span><strong>{summary.highPriority}</strong></div>
    <div><span>待回填结果</span><strong>{summary.awaitingResult}</strong></div>
  </section>;
}

function Automation({ settings, lastDiscoveredAt, saving, onSave }: { settings: OpportunitySettings; lastDiscoveredAt: string | null; saving: boolean; onSave: (value: OpportunitySettings) => void }) {
  return <section className="de-opportunity-automation">
    <span>最近发现：<strong>{lastDiscoveredAt ? formatTime(lastDiscoveredAt) : "尚未运行"}</strong></span>
    <label className="de-switch"><input type="checkbox" checked={settings.enabled} disabled={saving} onChange={(event) => onSave({ ...settings, enabled: event.target.checked })} /><i /><span>每日自动发现</span></label>
    <label><span>执行时间</span><input type="time" value={settings.dailyRunTime} disabled={!settings.enabled || saving} onChange={(event) => onSave({ ...settings, dailyRunTime: event.target.value })} /></label>
    <small>{settings.enabled && settings.nextRunAt ? `下次 ${formatTime(settings.nextRunAt)}` : "默认关闭，不会产生模型费用"}</small>
  </section>;
}

function Filters({ values, onChange }: { values: FilterValues; onChange: (value: FilterValues) => void }) {
  const field = (key: string, value: string) => onChange({ ...values, [key]: value });
  return <section className="de-filter-card de-opportunity-filters" aria-label="商机筛选">
    <label className="de-filter-select"><span>准备度</span><select value={values.readiness} onChange={(e) => field("readiness", e.target.value)}><option value="">全部</option>{Object.entries(READINESS_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
    <label className="de-filter-select"><span>优先级</span><select value={values.priority} onChange={(e) => field("priority", e.target.value)}><option value="">全部</option><option value="high">高</option><option value="normal">中</option><option value="low">低</option></select></label>
    <label className="de-filter-select"><span>机会类型</span><select value={values.opportunityType} onChange={(e) => field("opportunityType", e.target.value)}><option value="">全部</option>{FIRST_TYPES.map((v) => <option key={v} value={v}>{OPPORTUNITY_TYPE_LABELS[v]}</option>)}</select></label>
    <label className="de-filter-select"><span>客户阶段</span><select value={values.relationshipStage} onChange={(e) => field("relationshipStage", e.target.value)}><option value="">全部</option>{Object.entries(RELATIONSHIP_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
    <label className="de-filter-select de-opportunity-product-filter"><span>产品</span><input placeholder="产品名称" value={values.product} onChange={(e) => field("product", e.target.value)} /></label>
    <label className="de-filter-select"><span>发现自</span><input type="date" value={values.suggestedFrom} onChange={(e) => field("suggestedFrom", e.target.value)} /></label>
    <label className="de-filter-select"><span>发现至</span><input type="date" value={values.suggestedTo} onChange={(e) => field("suggestedTo", e.target.value)} /></label>
    {Object.values(values).some(Boolean) && <button className="de-quiet-button" onClick={() => onChange({ readiness: "", priority: "", opportunityType: "", relationshipStage: "", product: "", suggestedFrom: "", suggestedTo: "" })}>清除筛选</button>}
  </section>;
}

function OpportunityCard({ item, llmModels, onOpenProfile, onAction, onExecute, onCancel }: {
  item: OpportunityItem; llmModels: CatalogModel[]; onOpenProfile: (id: string) => void;
  onAction: (item: OpportunityItem, action: "accept" | "snooze" | "dismiss" | "reschedule" | "result") => void;
  onExecute: () => void; onCancel: () => void;
}) {
  const [talkOpen, setTalkOpen] = useState(false);
  const blocked = item.riskFlags.some((risk) => risk.blocking);
  return <article className={`de-opportunity-card priority-${item.priority} ${item.overdue ? "is-overdue" : ""} ${blocked ? "is-blocked" : ""} ${talkOpen ? "has-talk-track" : ""}`}>
    <header>
      <div className="de-opportunity-identity">
        <button className="de-opportunity-customer" onClick={() => onOpenProfile(item.profileId)}><span>{item.customerName.slice(0, 1)}</span><strong>{item.customerName}<small>{item.organization || RELATIONSHIP_LABELS[item.relationshipStage]}</small></strong></button>
        <button type="button" className={`de-talk-track-toggle${talkOpen ? " is-open" : ""}`} aria-expanded={talkOpen} onClick={() => setTalkOpen((value) => !value)}>
          <span aria-hidden="true">✦</span>联系话术
        </button>
      </div>
      <div className="de-opportunity-badges"><i className={`source-${item.source}`}>{item.source === "manual" ? "确定提醒" : "AI 商机"}</i><span>{OPPORTUNITY_TYPE_LABELS[item.opportunityType]}</span><b className={`priority-${item.priority}`}>{PRIORITY_LABELS[item.priority]}</b><em>{READINESS_LABELS[item.readiness]}</em></div>
    </header>
    <TalkTrackAssistant item={item} open={talkOpen} llmModels={llmModels} onClose={() => setTalkOpen(false)} />
    <div className="de-opportunity-body">
      <div className="de-opportunity-main">
        <h2>{item.title}</h2><p>{item.objective}</p>
        <h3>为什么现在</h3>
        <ul>{item.evidence.map((evidence, index) => <li key={`${evidence.sourceId ?? evidence.sourceType}-${index}`}><time>{shortDate(evidence.occurredAt)}</time><span>{evidence.fact}</span></li>)}</ul>
        {item.riskFlags.map((risk) => <div key={risk.code} className={`de-opportunity-risk ${risk.blocking ? "blocking" : ""}`}>⚠ {risk.message}</div>)}
      </div>
      <aside><span>建议怎么做</span><strong>{item.followUpMethod || "根据客户偏好"}</strong><p>{item.scheduledAt ? formatTime(item.scheduledAt) : formatTime(item.suggestedAt)}</p>{item.productName && <small>关联：{item.productName}</small>}{item.resultCriteria && <small>结果口径：{item.resultCriteria}</small>}</aside>
    </div>
    <footer>
      {item.view === "pending" && <><button className="de-primary-button" disabled={blocked} onClick={() => onAction(item, "accept")}>采纳并确认行动</button><button className="de-secondary-button" onClick={() => onAction(item, "snooze")}>稍后</button><button className="de-quiet-button" onClick={() => onAction(item, "dismiss")}>忽略</button></>}
      {item.view === "in_progress" && <><button className="de-primary-button" onClick={onExecute}>标记已执行</button><button className="de-secondary-button" onClick={() => onAction(item, "reschedule")}>改时间</button><button className="de-quiet-button" onClick={onCancel}>取消</button></>}
      {item.view === "awaiting_result" && <button className="de-primary-button" onClick={() => onAction(item, "result")}>回填结果</button>}
      {item.view === "completed" && <><span className="de-opportunity-outcome">{item.closeReason === "overdue_closed" ? "已逾期关闭" : OUTCOME_LABELS[item.outcome ?? ""] || "已取消"}</span>{item.customerQuote && <q>{item.customerQuote}</q>}</>}
      <button className="de-opportunity-profile-link" onClick={() => onOpenProfile(item.profileId)}>查看画像与来源 →</button>
    </footer>
  </article>;
}

const TALK_TRACK_PRESETS: Array<{ intent: TalkTrackIntent; label: string; prompt: string }> = [
  { intent: "maintenance", label: "维护问候", prompt: "请生成一段自然、不带强推销感的客户维护问候话术。" },
  { intent: "follow_up", label: "跟进联络", prompt: "请根据当前事项生成一段可直接发送的跟进联络话术，明确但不要给客户压力。" },
  { intent: "sales", label: "产品推介", prompt: "请结合客户需求和已核实的产品资料，生成一段有针对性的产品推介话术。" },
];

function TalkTrackAssistant({ item, open, llmModels, onClose }: { item: OpportunityItem; open: boolean; llmModels: CatalogModel[]; onClose: () => void }) {
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
  return <section className="de-talk-track-panel" aria-label={`${item.customerName}联系话术助手`}>
      <header><div><strong>单客户话术助手</strong><span>已带入 {item.customerName} 的画像、当前事项{item.productName ? `和${item.productName}资料` : ""}</span></div><button type="button" onClick={onClose} aria-label="收起话术助手">×</button></header>
      <div className="de-talk-track-presets">
        {TALK_TRACK_PRESETS.map((preset) => <button type="button" key={preset.intent} disabled={loading || !effectiveModel} className={intent === preset.intent ? "active" : ""} onClick={() => void send(preset.prompt, preset.intent)}>{preset.label}</button>)}
      </div>
      {messages.length === 0 && <div className="de-talk-track-empty"><span>✦</span><p>选择一种场景直接生成，或在下方说明渠道、语气和想达到的目的。</p></div>}
      {messages.length > 0 && <div className="de-talk-track-messages">
        {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`de-talk-track-message ${message.role}`}>
          <span>{message.role === "assistant" ? "参谋" : "你"}</span><p>{message.content}</p>
          {message.role === "assistant" && <button type="button" onClick={() => void navigator.clipboard.writeText(message.content)}>复制</button>}
        </div>)}
        {loading && <div className="de-talk-track-thinking"><i /><span>正在结合客户信息生成…</span></div>}
      </div>}
      {error && <p className="de-talk-track-error" role="alert">{error}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void send(input); }}>
        <div className="de-talk-track-composer">
          <textarea value={input} maxLength={2_000} rows={2} disabled={loading || !effectiveModel} placeholder={effectiveModel ? "例如：语气更熟悉一点，适合微信，先询问对方是否方便……" : "平台暂未返回可用的 LLM 模型"} onChange={(event) => setInput(event.target.value)} onCompositionStart={() => { compositionActiveRef.current = true; }} onCompositionEnd={() => { compositionActiveRef.current = false; }} onKeyDown={(event) => {
            if (shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, compositionActiveRef.current)) { event.preventDefault(); void send(input); }
          }} />
          <div className="de-talk-track-composer-toolbar">
            <span>当前 Key 模型</span>
            <ModelPicker models={llmModels} value={effectiveModel} onChange={setSelectedModel} disabled={loading} />
          </div>
        </div>
        <button type="submit" className="de-primary-button" disabled={loading || !effectiveModel || !input.trim()}>{loading ? "生成中" : "发送"}</button>
      </form>
      <small>AI 话术仅供参考，发送前请核对客户事实、产品承诺和价格权益。</small>
    </section>;
}

function Empty({ view, hasProfiles, hasFilters, onCreateProfile, onDiscover }: { view: OpportunityView; hasProfiles: boolean; hasFilters: boolean; onCreateProfile: () => void; onDiscover: () => void }) {
  const content = !hasProfiles ? ["还没有可经营的客户画像", "商机雷达只围绕已建档的单个客户工作，请先建立客户画像。"] : hasFilters ? ["没有符合筛选条件的客户事项", "清除或调整筛选条件后再看。"] : view === "today" ? ["今天没有必须处理的客户事项", "可以查看待判断商机，或手动安排一次回访和维护。"] : view === "pending" ? ["当前没有需要判断的新商机", "可以立即运行一次发现；确定性提醒仍会按计划出现在今日经营。"] : ["这个视图目前为空", "行动采纳、执行和结果回填后会自动流转到对应视图。"];
  return <div className="de-state de-empty-state de-opportunity-empty"><span className="de-empty-icon">◇</span><strong>{content[0]}</strong><p>{content[1]}</p>{!hasProfiles ? <button className="de-primary-button" onClick={onCreateProfile}>新建客户</button> : view === "pending" && <button className="de-secondary-button" onClick={onDiscover}>发现新商机</button>}</div>;
}

function DialogFrame({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="de-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="de-modal de-opportunity-dialog" role="dialog" aria-modal="true"><header className="de-modal-head"><div><h2>{title}</h2></div><button className="de-icon-button" onClick={onClose}>×</button></header>{children}</section></div>;
}

function AcceptDialog({ item, onClose, onSave }: { item: OpportunityItem; onClose: () => void; onSave: (input: Record<string, unknown>) => void }) {
  const [objective, setObjective] = useState(item.objective); const [method, setMethod] = useState(item.followUpMethod || "企微/微信");
  const [scheduledAt, setScheduledAt] = useState(localInput(item.scheduledAt || item.suggestedAt)); const [criteria, setCriteria] = useState(item.resultCriteria || "获得有效回复或下一步");
  return <DialogFrame title="确认跟进行动" onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave({ objective, followUpMethod: method, scheduledAt: new Date(scheduledAt).toISOString(), resultCriteria: criteria }); }}>
    <div className="de-dialog-context"><strong>{item.customerName} · {OPPORTUNITY_TYPE_LABELS[item.opportunityType]}</strong><p>{item.reason}</p></div>
    <div className="de-form-grid"><label><span>推荐目标</span><textarea value={objective} onChange={(e) => setObjective(e.target.value)} required /></label><label><span>结果口径</span><textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} required /></label><label><span>沟通方式</span><select value={method} onChange={(e) => setMethod(e.target.value)}><option>企微/微信</option><option>电话</option><option>邮件</option><option>线下拜访</option></select></label><label><span>计划时间</span><input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required /></label></div>
    <p className="de-field-hint">采纳后形成该客户的正式行动，不会创建客群营销项目；单客户联系话术将在商机雷达内继续准备。</p>
    <div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>取消</button><button className="de-primary-button">采纳并创建行动</button></div>
  </form></DialogFrame>;
}

function SnoozeDialog({ onClose, onSave }: { onClose: () => void; onSave: (value: string) => void }) {
  const tomorrow = new Date(Date.now() + 86_400_000); const [value, setValue] = useState(tomorrow.toISOString().slice(0, 10));
  return <DialogFrame title="稍后处理" onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave(new Date(`${value}T09:00:00`).toISOString()); }}><label><span>恢复日期</span><input type="date" min={new Date().toISOString().slice(0,10)} value={value} onChange={(e) => setValue(e.target.value)} required /></label><p className="de-field-hint">到期后商机会自动回到“待判断”。</p><div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>取消</button><button className="de-primary-button">确认稍后</button></div></form></DialogFrame>;
}

function DismissDialog({ onClose, onSave }: { onClose: () => void; onSave: (value: string) => void }) {
  const [reason, setReason] = useState("");
  return <DialogFrame title="忽略商机" onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave(reason); }}><label><span>选择一个原因</span><select value={reason} onChange={(e) => setReason(e.target.value)} required><option value="">请选择</option>{DISMISS_REASONS.map((item) => <option key={item}>{item}</option>)}</select></label>{reason === "信息不准确" && <p className="de-field-hint">确认后将打开客户画像，方便纠正事实。</p>}<div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>取消</button><button className="de-danger-button">忽略</button></div></form></DialogFrame>;
}

function RescheduleDialog({ item, onClose, onSave }: { item: OpportunityItem; onClose: () => void; onSave: (value: string) => void }) {
  const [value, setValue] = useState(localInput(item.scheduledAt || new Date().toISOString()));
  return <DialogFrame title="调整跟进时间" onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave(new Date(value).toISOString()); }}><label><span>新的计划时间</span><input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} required /></label><div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>取消</button><button className="de-primary-button">保存</button></div></form></DialogFrame>;
}

function ResultDialog({ item, onClose, onSave }: { item: OpportunityItem; onClose: () => void; onSave: (value: Record<string, unknown>) => void }) {
  const [outcome, setOutcome] = useState(""); const [quote, setQuote] = useState(""); const [note, setNote] = useState(""); const [nextAction, setNextAction] = useState(""); const [nextAt, setNextAt] = useState(""); const [stage, setStage] = useState("");
  return <DialogFrame title={`回填结果 · ${item.customerName}`} onClose={onClose}><form className="de-form" onSubmit={(e) => { e.preventDefault(); onSave({ outcome, customerQuote: quote || undefined, note: note || undefined, nextAction: nextAction || undefined, nextActionAt: nextAt ? new Date(nextAt).toISOString() : undefined, confirmedRelationshipStage: stage || undefined }); }}>
    <fieldset className="de-result-options"><legend>本次结果</legend>{Object.entries(OUTCOME_LABELS).map(([value,label]) => <label key={value} className={outcome === value ? "active" : ""}><input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} required /><span>{label}</span></label>)}</fieldset>
    <div className="de-form-grid"><label><span>客户原话（选填）</span><textarea value={quote} onChange={(e) => setQuote(e.target.value)} /></label><label><span>补充说明（选填）</span><textarea value={note} onChange={(e) => setNote(e.target.value)} /></label><label><span>下一步行动</span><input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="有下一步时填写" /></label><label><span>预计时间</span><input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} required={Boolean(nextAction)} /></label><label><span>确认更新客户阶段</span><select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">暂不更新</option>{Object.entries(RELATIONSHIP_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label></div>
    <div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>取消</button><button className="de-primary-button">保存结果</button></div>
  </form></DialogFrame>;
}

function formatTime(value: string) { const date = new Date(value); return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
function shortDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value)); }
function localInput(value: string) { const date = new Date(value); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }

function CreateActionDialog({ onClose, onSave }: { onClose: () => void; onSave: (input: Record<string, unknown>) => void }) {
  const [query, setQuery] = useState("");
  const [profiles, setProfiles] = useState<Array<{ id: string; displayName: string; organization: string | null }>>([]);
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
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

  const pickProfile = (id: string, name: string) => { setProfileId(id); setProfileName(name); setQuery(""); setProfiles([]); };

  return <DialogFrame title="手动添加跟进行动" onClose={onClose}>
    <form className="de-form" onSubmit={(e) => {
      e.preventDefault();
      onSave({ profileId, opportunityType, title, objective, followUpMethod: method, priority,
        scheduledAt: new Date(scheduledAt).toISOString(), resultCriteria: criteria || undefined,
        productName: productName || undefined });
    }}>
      <div className="de-form-grid">
        <label className="de-form-full"><span>客户</span>
          {profileId ? (
            <div className="de-selected-profile">{profileName}<button type="button" className="de-quiet-button" onClick={() => { setProfileId(""); setProfileName(""); }}>更换</button></div>
          ) : (
            <div className="de-profile-search">
              <input placeholder="输入客户姓名搜索" value={query} onChange={(e) => setQuery(e.target.value)} required={!profileId} />
              {searching && <small>搜索中…</small>}
              {profiles.length > 0 && <ul className="de-profile-dropdown">
                {profiles.map((p) => <li key={p.id}><button type="button" onClick={() => pickProfile(p.id, p.displayName)}>{p.displayName}{p.organization && <small>{p.organization}</small>}</button></li>)}
              </ul>}
            </div>
          )}
          <input type="hidden" value={profileId} required />
        </label>
        <label><span>机会类型</span>
          <select value={opportunityType} onChange={(e) => setOpportunityType(e.target.value as OpportunityType)}>
            {FIRST_TYPES.map((v) => <option key={v} value={v}>{OPPORTUNITY_TYPE_LABELS[v]}</option>)}
          </select>
        </label>
        <label><span>优先级</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="high">高</option><option value="normal">中</option><option value="low">低</option>
          </select>
        </label>
        <label className="de-form-full"><span>行动标题</span><input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
        <label className="de-form-full"><span>跟进目标</span><textarea value={objective} onChange={(e) => setObjective(e.target.value)} required /></label>
        <label><span>沟通方式</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>企微/微信</option><option>电话</option><option>邮件</option><option>线下拜访</option>
          </select>
        </label>
        <label><span>计划时间</span><input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required /></label>
        <label><span>结果口径（选填）</span><input value={criteria} onChange={(e) => setCriteria(e.target.value)} /></label>
        <label><span>关联产品（选填）</span><input value={productName} onChange={(e) => setProductName(e.target.value)} /></label>
      </div>
      <div className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>取消</button><button className="de-primary-button">创建行动</button></div>
    </form>
  </DialogFrame>;
}
