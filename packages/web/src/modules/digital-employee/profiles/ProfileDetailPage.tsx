import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import { ProfileEditor } from "../components/ProfileEditor.js";
import {
  HEALTH_LABELS,
  JOURNEY_LABELS,
  OBSERVATION_LABELS,
  RELATIONSHIP_LABELS,
  SATISFACTION_LABELS,
  SENTIMENT_LABELS,
  type CustomerProductState,
  type CustomerProfile,
  type CustomerStateChange,
  type Health,
  type JourneyStage,
  type ManualObservationInput,
  type ObservationType,
  type ProductStateUpdateInput,
  type ProfileInput,
  type ProfileUpdateInput,
  type Satisfaction,
  type Sentiment,
} from "../types.js";

interface ProfileDetailPageProps {
  profileId: string;
  onBack: () => void;
}

const JOURNEY_OPTIONS = Object.entries(JOURNEY_LABELS) as Array<[JourneyStage, string]>;
const HEALTH_OPTIONS = Object.entries(HEALTH_LABELS) as Array<[Health, string]>;
const SENTIMENT_OPTIONS = Object.entries(SENTIMENT_LABELS) as Array<[Sentiment, string]>;
const SATISFACTION_OPTIONS = Object.entries(SATISFACTION_LABELS) as Array<[Satisfaction, string]>;
const OBSERVATION_OPTIONS = Object.entries(OBSERVATION_LABELS) as Array<[ObservationType, string]>;

function dateTime(value: string | null): string {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未记录" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function shortValues(values: unknown[]): string {
  return values.map((value) => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return typeof record.summary === "string" ? record.summary : typeof record.text === "string" ? record.text : JSON.stringify(value);
    }
    return String(value);
  }).filter(Boolean).join("；");
}

export function ProfileDetailPage({ profileId, onBack }: ProfileDetailPageProps) {
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [products, setProducts] = useState<CustomerProductState[]>([]);
  const [timeline, setTimeline] = useState<{ observations: Array<{ id: string; rawText: string; eventType?: string; occurredAt: string | null; createdAt: string }>; changes: CustomerStateChange[] }>({ observations: [], changes: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editProfile, setEditProfile] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [stateEditor, setStateEditor] = useState<CustomerProductState | "new" | null>(null);
  const [savingState, setSavingState] = useState(false);
  const [note, setNote] = useState("");
  const [noteType, setNoteType] = useState<ObservationType>("note");
  const [noteProduct, setNoteProduct] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, nextTimeline] = await Promise.all([
        api.getCustomerProfile(profileId),
        api.getCustomerTimeline(profileId),
      ]);
      setProfile(detail.profile);
      setProducts(detail.productStates);
      setTimeline(nextTimeline);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "客户画像加载失败");
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => { void reload(); }, [reload]);

  const saveProfile = async (input: ProfileInput) => {
    if (!profile) return;
    setSavingProfile(true);
    try {
      const updated = await api.updateCustomerProfile(profile.id, { ...input, version: profile.version } as ProfileUpdateInput);
      setProfile(updated);
      setEditProfile(false);
      await reload();
    } finally {
      setSavingProfile(false);
    }
  };

  const saveProduct = async (input: ProductStateUpdateInput & { productName: string }) => {
    if (!profile) return;
    setSavingState(true);
    try {
      const key = stateEditor === "new" ? normalizeProductKey(input.productName) : stateEditor!.productKey;
      const result = await api.updateCustomerProductState(profile.id, key, stateEditor === "new" ? input : { ...input, version: stateEditor!.version });
      setProfile(result.profile);
      setStateEditor(null);
      await reload();
    } finally {
      setSavingState(false);
    }
  };

  const addObservation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile || !note.trim()) return;
    setSavingNote(true);
    try {
      const input: ManualObservationInput = {
        rawText: note.trim(),
        eventType: noteType,
        productName: noteProduct.trim() || undefined,
      };
      await api.addCustomerObservation(profile.id, input);
      setNote("");
      setNoteProduct("");
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "记录观察失败");
    } finally {
      setSavingNote(false);
    }
  };

  const archive = async () => {
    if (!profile || !window.confirm(`确定归档「${profile.displayName}」吗？归档后不会出现在默认列表中。`)) return;
    try {
      await api.archiveCustomerProfile(profile.id, profile.version);
      onBack();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档失败");
    }
  };

  if (loading && !profile) return <div className="de-page de-state">正在读取客户画像…</div>;
  if (!profile) return <div className="de-page"><div className="de-inline-error">{error ?? "未找到该客户画像"}<button onClick={onBack}>返回列表</button></div></div>;

  const contactEntries = [
    ["手机号", profile.contact?.phone],
    ["邮箱", profile.contact?.email],
    ["微信", profile.contact?.wechat],
  ].filter(([, value]) => !!value) as Array<[string, string]>;

  return (
    <div className="de-page de-profile-detail-page">
      <header className="de-detail-header">
        <button className="de-back-button" onClick={onBack}>‹ 返回客户画像</button>
        <div className="de-detail-title-row">
          <div>
            <p className="de-eyebrow">客户画像 / 详情</p>
            <h1>{profile.displayName}</h1>
            <p>{profile.customerRegion || "尚未补充客户区域"}</p>
          </div>
          <div className="de-header-actions">
            {profile.status === "active" && <><button className="de-secondary-button" onClick={() => setEditProfile(true)}>编辑画像</button><button className="de-danger-button" onClick={() => void archive()}>归档</button></>}
          </div>
        </div>
      </header>

      {error && <div className="de-inline-error" role="alert"><span>{error}</span><button onClick={() => void reload()}>重试</button></div>}

      <div className="de-detail-grid">
        <section className="de-detail-card de-profile-overview">
          <div className="de-card-heading"><h2>基本资料</h2><span className={`de-status-chip stage-${profile.relationshipStage}`}>{RELATIONSHIP_LABELS[profile.relationshipStage]}</span></div>
          <dl className="de-info-list">
            <div><dt>别名</dt><dd>{profile.aliases.length ? profile.aliases.join("、") : "—"}</dd></div>
            <div><dt>客户区域</dt><dd>{profile.customerRegion || "—"}</dd></div>
            <div><dt>来源</dt><dd>{profile.source || "—"}</dd></div>
            <div><dt>整体健康度</dt><dd><span className={`de-status-chip health-${profile.overallHealth}`}>{HEALTH_LABELS[profile.overallHealth]}</span></dd></div>
            <div><dt>最近观察</dt><dd>{dateTime(profile.lastObservedAt)}</dd></div>
            <div><dt>最近联系</dt><dd>{dateTime(profile.lastContactAt)}</dd></div>
            <div><dt>人工锁定</dt><dd>{profile.manualLockFields.length ? profile.manualLockFields.join("、") : "未锁定"}</dd></div>
          </dl>
          {contactEntries.length > 0 && <div className="de-contact-strip">{contactEntries.map(([label, value]) => <span key={label}><small>{label}</small>{value}</span>)}</div>}
          <div className="de-tag-list de-detail-tags">{profile.tags.length ? profile.tags.map((tag) => <span key={tag}>{tag}</span>) : <em>暂无标签</em>}</div>
        </section>

        <section className="de-detail-card de-summary-card">
          <div className="de-card-heading"><h2>动态摘要</h2><span>版本 {profile.summaryVersion}</span></div>
          <p>{profile.summary || "当前还没有足够的观察记录。"}</p>
          <small>摘要只基于当前投影生成，不会把完整历史原文发送给模型。</small>
        </section>
      </div>

      <section className="de-section">
        <div className="de-section-heading"><div><h2>产品关系</h2><p>每个产品独立维护购买阶段、满意度、问题和风险。</p></div>{profile.status === "active" && <button className="de-secondary-button" onClick={() => setStateEditor("new")}>＋ 添加产品</button>}</div>
        {products.length === 0 ? <div className="de-empty-inline">尚未关联产品。添加产品后可独立记录试用、使用和反馈状态。</div> : <div className="de-product-grid">{products.map((state) => <ProductStateCard key={state.id} state={state} disabled={profile.status !== "active"} onEdit={() => setStateEditor(state)} />)}</div>}
      </section>

      {profile.status === "active" && <section className="de-section de-observation-section">
        <div className="de-section-heading"><div><h2>补充观察记录</h2><p>原文将作为可追溯事实保存；没有填写结构化字段时不会臆测客户状态。</p></div></div>
        <form className="de-observation-form" onSubmit={addObservation}>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：李姐反馈边缘算力性能在高峰期不稳定，希望本周安排技术支持。" maxLength={12_000} />
          <div className="de-observation-controls">
            <label><span>记录类型</span><select value={noteType} onChange={(event) => setNoteType(event.target.value as ObservationType)}>{OBSERVATION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>关联产品（可选）</span><input value={noteProduct} onChange={(event) => setNoteProduct(event.target.value)} maxLength={200} placeholder="如：边缘算力" /></label>
            <button className="de-primary-button" disabled={savingNote || !note.trim()}>{savingNote ? "保存中…" : "保存记录"}</button>
          </div>
        </form>
      </section>}

      <section className="de-section">
        <div className="de-section-heading"><div><h2>观察与变更时间线</h2><p>原始记录与状态投影分别保留，便于解释变化来源。</p></div></div>
        <div className="de-timeline">
          {timeline.observations.length === 0 && timeline.changes.length === 0 ? <div className="de-empty-inline">暂无观察或状态变更。</div> : <>
            {timeline.observations.map((observation) => <article className="de-timeline-item observation" key={`o-${observation.id}`}><span className="de-timeline-dot" /><div><header><strong>{OBSERVATION_LABELS[(observation.eventType as ObservationType) ?? "note"] ?? "观察记录"}</strong><time>{dateTime(observation.occurredAt ?? observation.createdAt)}</time></header><p>{observation.rawText}</p></div></article>)}
            {timeline.changes.map((change) => <StateChangeItem key={`c-${change.id}`} change={change} />)}
          </>}
        </div>
      </section>

      {editProfile && <ProfileEditor profile={profile} saving={savingProfile} onClose={() => !savingProfile && setEditProfile(false)} onSave={saveProfile} />}
      {stateEditor && <ProductStateEditor state={stateEditor === "new" ? undefined : stateEditor} saving={savingState} onClose={() => !savingState && setStateEditor(null)} onSave={saveProduct} />}
    </div>
  );
}

function ProductStateCard({ state, disabled, onEdit }: { state: CustomerProductState; disabled: boolean; onEdit: () => void }) {
  return <article className="de-product-card">
    <header><div><h3>{state.productName}</h3><span>{state.productKey}</span></div>{!disabled && <button className="de-row-action" onClick={onEdit}>编辑</button>}</header>
    <div className="de-product-metrics"><span><small>阶段</small><b>{JOURNEY_LABELS[state.journeyStage]}</b></span><span><small>满意度</small><b>{SATISFACTION_LABELS[state.satisfaction]}</b></span><span><small>健康度</small><b className={`health-text-${state.health}`}>{HEALTH_LABELS[state.health]}</b></span></div>
    {shortValues(state.currentIssues) && <p><small>当前问题</small>{shortValues(state.currentIssues)}</p>}
    {shortValues(state.objections) && <p><small>异议</small>{shortValues(state.objections)}</p>}
    {state.manualLockFields.length > 0 && <footer>已锁定：{state.manualLockFields.join("、")}</footer>}
  </article>;
}

function StateChangeItem({ change }: { change: CustomerStateChange }) {
  const fields = Object.entries(change.patch).map(([key, value]) => `${key} → ${formatValue(value)}`).join("；");
  return <article className="de-timeline-item change"><span className="de-timeline-dot" /><div><header><strong>{change.actorType === "user" ? "人工状态修正" : "已确认的画像更新"}</strong><time>{dateTime(change.createdAt)}</time></header><p>{change.reason || "状态更新"}{fields ? `：${fields}` : ""}</p></div></article>;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("、");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function normalizeProductKey(name: string): string {
  const value = name.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return value || "product";
}

function ProductStateEditor({ state, saving, onClose, onSave }: {
  state?: CustomerProductState;
  saving: boolean;
  onClose: () => void;
  onSave: (input: ProductStateUpdateInput & { productName: string }) => Promise<void> | void;
}) {
  const [productName, setProductName] = useState(state?.productName ?? "");
  const [journeyStage, setJourneyStage] = useState<JourneyStage>(state?.journeyStage ?? "unknown");
  const [sentiment, setSentiment] = useState<Sentiment>(state?.sentiment ?? "unknown");
  const [satisfaction, setSatisfaction] = useState<Satisfaction>(state?.satisfaction ?? "unknown");
  const [health, setHealth] = useState<Health>(state?.health ?? "healthy");
  const [issues, setIssues] = useState(shortValues(state?.currentIssues ?? []));
  const [objections, setObjections] = useState(shortValues(state?.objections ?? []));
  const [lockJourney, setLockJourney] = useState(state?.manualLockFields.includes("journeyStage") ?? false);
  const [error, setError] = useState<string | null>(null);
  const parse = (text: string) => text.split(/[；;\n]/).map((item) => item.trim()).filter(Boolean);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!productName.trim()) { setError("请填写产品名称"); return; }
    setError(null);
    try {
      await onSave({ productName: productName.trim(), journeyStage, sentiment, satisfaction, health, currentIssues: parse(issues), objections: parse(objections), manualLockFields: lockJourney ? ["journeyStage"] : [] });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
  };
  return <div className="de-modal-backdrop" onMouseDown={onClose}><section className="de-modal de-product-editor" role="dialog" aria-modal="true" aria-label={state ? "编辑产品状态" : "添加产品"} onMouseDown={(event) => event.stopPropagation()}>
    <div className="de-modal-head"><div><h2>{state ? "编辑产品状态" : "添加产品关系"}</h2><p>销售阶段、使用满意度和风险独立记录。</p></div><button className="de-icon-button" type="button" onClick={onClose}>×</button></div>
    <form className="de-form" onSubmit={submit}><div className="de-form-grid"><label><span>产品名称 *</span><input value={productName} onChange={(event) => setProductName(event.target.value)} disabled={!!state} autoFocus /></label><label><span>旅程阶段</span><select value={journeyStage} onChange={(event) => setJourneyStage(event.target.value as JourneyStage)}>{JOURNEY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>最近态度</span><select value={sentiment} onChange={(event) => setSentiment(event.target.value as Sentiment)}>{SENTIMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>满意度</span><select value={satisfaction} onChange={(event) => setSatisfaction(event.target.value as Satisfaction)}>{SATISFACTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>健康度</span><select value={health} onChange={(event) => setHealth(event.target.value as Health)}>{HEALTH_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>当前问题</span><textarea value={issues} onChange={(event) => setIssues(event.target.value)} placeholder="用分号分隔" /></label><label><span>异议</span><textarea value={objections} onChange={(event) => setObjections(event.target.value)} placeholder="用分号分隔" /></label></div><fieldset className="de-form-section"><legend>人工锁定</legend><div className="de-check-row"><label><input type="checkbox" checked={lockJourney} onChange={(event) => setLockJourney(event.target.checked)} /> 锁定产品旅程阶段</label></div></fieldset>{error && <p className="de-form-error">{error}</p>}<footer className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="de-primary-button" disabled={saving}>{saving ? "保存中…" : "保存状态"}</button></footer></form>
  </section></div>;
}
