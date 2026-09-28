import { useI18n } from "../../../i18n/index.js";
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, api } from "../../../api/client.js";
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
  type MarketingProduct,
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

function dateTime(value: string | null, locale = "zh-CN"): string {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未记录" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
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
  const { t, locale } = useI18n();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [products, setProducts] = useState<CustomerProductState[]>([]);
  const [marketingProducts, setMarketingProducts] = useState<MarketingProduct[]>([]);
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
  const [archiveOpenCount, setArchiveOpenCount] = useState<number | null>(null);
  const [savingArchive, setSavingArchive] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, nextTimeline, productCatalog] = await Promise.all([
        api.getCustomerProfile(profileId),
        api.getCustomerTimeline(profileId),
        api.listMarketingProducts({ status: "active", limit: 100 }),
      ]);
      setProfile(detail.profile);
      setProducts(detail.productStates);
      setTimeline(nextTimeline);
      setMarketingProducts(productCatalog.items);
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

  const saveProduct = async (input: ProductStateUpdateInput & { productName: string; marketingProductId?: string }) => {
    if (!profile) return;
    setSavingState(true);
    try {
      if (stateEditor === "new" && !input.marketingProductId) throw new Error("请选择营销资料中的有效产品");
      const key = stateEditor === "new" ? `marketing:${input.marketingProductId}` : stateEditor!.productKey;
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
        ...(noteProduct ? {
          marketingProductId: noteProduct,
          productName: marketingProducts.find((product) => product.id === noteProduct)?.name,
        } : {}),
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

  const archive = async (onOpenTasks?: "cancel" | "keep") => {
    if (!profile) return;
    if (onOpenTasks === undefined && archiveOpenCount === null) {
      if (!window.confirm(t(`确定归档「${profile.displayName}」吗？归档后不会出现在默认列表和商机待办中。`))) return;
    }
    setSavingArchive(true);
    setError(null);
    try {
      await api.archiveCustomerProfile(profile.id, profile.version, onOpenTasks);
      onBack();
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.code === "open_tasks") {
        setArchiveOpenCount(typeof reason.details.openTaskCount === "number" ? reason.details.openTaskCount : 0);
      } else {
        setError(reason instanceof Error ? reason.message : "归档失败");
      }
    } finally {
      setSavingArchive(false);
    }
  };

  if (loading && !profile) return <div className="de-page de-state">{t("正在读取客户画像…")}</div>;
  if (!profile) return <div className="de-page"><div className="de-inline-error">{t(error) ?? t("未找到该客户画像")}<button onClick={onBack}>{t("返回列表")}</button></div></div>;

  const contactEntries = [
    ["手机号", profile.contact?.phone],
    ["邮箱", profile.contact?.email],
    ["微信", profile.contact?.wechat],
  ].filter(([, value]) => !!value) as Array<[string, string]>;

  const allActiveProductsLinked = marketingProducts.length > 0
    && marketingProducts.every((product) => products.some((state) => state.marketingProductId === product.id));

  return (
    <div className="de-page de-profile-detail-page">
      <header className="de-detail-header">
        <button className="de-back-button" onClick={onBack}>{t("‹ 返回客户画像")}</button>
        <div className="de-detail-title-row">
          <div>
            <p className="de-eyebrow">{t("客户画像 / 详情")}</p>
            <h1>{profile.displayName}</h1>
            <p>{profile.customerRegion || t("尚未补充客户区域")}</p>
          </div>
          <div className="de-header-actions">
            {profile.status === "active" && <><button className="de-secondary-button" onClick={() => setEditProfile(true)}>{t("编辑画像")}</button><button className="de-danger-button" onClick={() => void archive()}>{t("归档")}</button></>}
          </div>
        </div>
      </header>

      {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span><button onClick={() => void reload()}>{t("重试")}</button></div>}
      {archiveOpenCount !== null && profile && (
        <div className="de-modal-backdrop" onMouseDown={() => !savingArchive && setArchiveOpenCount(null)}>
          <section className="de-modal" role="dialog" aria-modal="true" aria-label={t("处理未完成跟进")} onMouseDown={(event) => event.stopPropagation()}>
            <div className="de-modal-head">
              <div>
                <h2>{t("归档「")}{profile.displayName}」</h2>
                <p>{t("该客户还有")}{archiveOpenCount} {t("项未完成跟进。请选择取消或保留这些任务后再归档；归档后不会出现在商机待办中。")}</p>
              </div>
              <button className="de-icon-button" type="button" onClick={() => setArchiveOpenCount(null)} disabled={savingArchive}>×</button>
            </div>
            <footer className="de-modal-actions">
              <button type="button" className="de-secondary-button" onClick={() => setArchiveOpenCount(null)} disabled={savingArchive}>{t("返回")}</button>
              <button type="button" className="de-secondary-button" onClick={() => void archive("keep")} disabled={savingArchive}>{t("保留任务并归档")}</button>
              <button type="button" className="de-danger-button" onClick={() => void archive("cancel")} disabled={savingArchive}>{t("取消任务并归档")}</button>
            </footer>
          </section>
        </div>
      )}

      <div className="de-detail-grid">
        <section className="de-detail-card de-profile-overview">
          <div className="de-card-heading"><h2>{t("基本资料")}</h2><span className={`de-status-chip stage-${profile.relationshipStage}`}>{t(RELATIONSHIP_LABELS[profile.relationshipStage])}</span></div>
          <dl className="de-info-list">
            <div><dt>{t("别名")}</dt><dd>{profile.aliases.length ? profile.aliases.join("、") : "—"}</dd></div>
            <div><dt>{t("客户区域")}</dt><dd>{profile.customerRegion || "—"}</dd></div>
            <div><dt>{t("来源")}</dt><dd>{profile.source || "—"}</dd></div>
            <div><dt>{t("整体健康度")}</dt><dd><span className={`de-status-chip health-${profile.overallHealth}`}>{t(HEALTH_LABELS[profile.overallHealth])}</span></dd></div>
            <div><dt>{t("最近观察")}</dt><dd>{dateTime(profile.lastObservedAt, locale)}</dd></div>
            <div><dt>{t("最近联系")}</dt><dd>{dateTime(profile.lastContactAt, locale)}</dd></div>
            <div><dt>{t("人工锁定")}</dt><dd>{profile.manualLockFields.length ? profile.manualLockFields.join("、") : t("未锁定")}</dd></div>
          </dl>
          {contactEntries.length > 0 && <div className="de-contact-strip">{contactEntries.map(([label, value]) => <span key={label}><small>{t(label)}</small>{value}</span>)}</div>}
          <div className="de-tag-list de-detail-tags">{profile.tags.length ? profile.tags.map((tag) => <span key={tag}>{tag}</span>) : <em>{t("暂无标签")}</em>}</div>
        </section>

        <section className="de-detail-card de-summary-card">
          <div className="de-card-heading"><h2>{t("动态摘要")}</h2><span>{t("版本")}{profile.summaryVersion}</span></div>
          <p>{profile.summary || t("当前还没有足够的观察记录。")}</p>
          <small>{t("摘要只基于当前投影生成，不会把完整历史原文发送给模型。")}</small>
        </section>
      </div>

      <section className="de-section">
        <div className="de-section-heading"><div><h2>{t("产品关系")}</h2><p>{t("关联营销资料中的产品，并独立维护购买阶段、满意度、问题和风险。")}</p></div>{profile.status === "active" && <button className="de-secondary-button" disabled={marketingProducts.length === 0 || allActiveProductsLinked} onClick={() => setStateEditor("new")}>{t("＋ 关联产品")}</button>}</div>
        {marketingProducts.length === 0 && <div className="de-product-catalog-hint">{t("营销资料中还没有有效产品，请先建立产品资料后再关联客户。")}</div>}
        {products.length === 0 ? <div className="de-empty-inline">{t("尚未关联产品。添加产品后可独立记录试用、使用和反馈状态。")}</div> : <div className="de-product-grid">{products.map((state) => <ProductStateCard key={state.id} state={state} disabled={profile.status !== "active"} onEdit={() => setStateEditor(state)} />)}</div>}
      </section>

      {profile.status === "active" && <section className="de-section de-observation-section">
        <div className="de-section-heading"><div><h2>{t("补充观察记录")}</h2><p>{t("原文将作为可追溯事实保存；没有填写结构化字段时不会臆测客户状态。")}</p></div></div>
        <form className="de-observation-form" onSubmit={addObservation}>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("例如：李姐反馈边缘算力性能在高峰期不稳定，希望本周安排技术支持。")} maxLength={12_000} />
          <div className="de-observation-controls">
            <label><span>{t("记录类型")}</span><select value={noteType} onChange={(event) => setNoteType(event.target.value as ObservationType)}>{OBSERVATION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
            <label><span>{t("关联产品（可选）")}</span><select value={noteProduct} onChange={(event) => setNoteProduct(event.target.value)}><option value="">{t("不关联产品")}</option>{marketingProducts.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
            <button className="de-primary-button" disabled={savingNote || !note.trim()}>{savingNote ? t("保存中…") : t("保存记录")}</button>
          </div>
        </form>
      </section>}

      <section className="de-section">
        <div className="de-section-heading"><div><h2>{t("观察与变更时间线")}</h2><p>{t("原始记录与状态投影分别保留，便于解释变化来源。")}</p></div></div>
        <div className="de-timeline">
          {timeline.observations.length === 0 && timeline.changes.length === 0 ? <div className="de-empty-inline">{t("暂无观察或状态变更。")}</div> : <>
            {timeline.observations.map((observation) => <article className="de-timeline-item observation" key={`o-${observation.id}`}><span className="de-timeline-dot" /><div><header><strong>{t(OBSERVATION_LABELS[(observation.eventType as ObservationType) ?? "note"]) ?? t("观察记录")}</strong><time>{dateTime(observation.occurredAt ?? observation.createdAt, locale)}</time></header><p>{observation.rawText}</p></div></article>)}
            {timeline.changes.map((change) => <StateChangeItem key={`c-${change.id}`} change={change} />)}
          </>}
        </div>
      </section>

      {editProfile && <ProfileEditor profile={profile} saving={savingProfile} onClose={() => !savingProfile && setEditProfile(false)} onSave={saveProfile} />}
      {stateEditor && <ProductStateEditor state={stateEditor === "new" ? undefined : stateEditor} products={stateEditor === "new" ? marketingProducts.filter((product) => !products.some((state) => state.marketingProductId === product.id)) : marketingProducts} saving={savingState} onClose={() => !savingState && setStateEditor(null)} onSave={saveProduct} />}
    </div>
  );
}

function ProductStateCard({ state, disabled, onEdit }: { state: CustomerProductState; disabled: boolean; onEdit: () => void }) {
  const { t } = useI18n();
  return <article className="de-product-card">
    <header><div><h3>{state.productName}</h3><span>{state.marketingProductId ? t("已关联营销资料") : t("待关联营销资料")}</span></div>{!disabled && <button className="de-row-action" onClick={onEdit}>{t("编辑")}</button>}</header>
    <div className="de-product-metrics"><span><small>{t("阶段")}</small><b>{t(JOURNEY_LABELS[state.journeyStage])}</b></span><span><small>{t("满意度")}</small><b>{t(SATISFACTION_LABELS[state.satisfaction])}</b></span><span><small>{t("健康度")}</small><b className={`health-text-${state.health}`}>{t(HEALTH_LABELS[state.health])}</b></span></div>
    {shortValues(state.currentIssues) && <p><small>{t("当前问题")}</small>{shortValues(state.currentIssues)}</p>}
    {shortValues(state.objections) && <p><small>{t("异议")}</small>{shortValues(state.objections)}</p>}
    {state.manualLockFields.length > 0 && <footer>{t("已锁定：")}{state.manualLockFields.join("、")}</footer>}
  </article>;
}

function StateChangeItem({ change }: { change: CustomerStateChange }) {
  const { t, locale } = useI18n();
  const fields = Object.entries(change.patch).map(([key, value]) => `${key} → ${formatValue(value)}`).join("；");
  return <article className="de-timeline-item change"><span className="de-timeline-dot" /><div><header><strong>{change.actorType === "user" ? t("人工状态修正") : t("已确认的画像更新")}</strong><time>{dateTime(change.createdAt, locale)}</time></header><p>{change.reason || t("状态更新")}{fields ? `：${fields}` : ""}</p></div></article>;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("、");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function ProductStateEditor({ state, products, saving, onClose, onSave }: {
  state?: CustomerProductState;
  products: MarketingProduct[];
  saving: boolean;
  onClose: () => void;
  onSave: (input: ProductStateUpdateInput & { productName: string; marketingProductId?: string }) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [marketingProductId, setMarketingProductId] = useState(state?.marketingProductId ?? "");
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
    const selectedProduct = products.find((product) => product.id === marketingProductId)
      ?? (state?.marketingProductId === marketingProductId ? { id: marketingProductId, name: state.productName } : undefined);
    if (!selectedProduct) { setError("请选择营销资料中的有效产品"); return; }
    setError(null);
    try {
      await onSave({
        productName: selectedProduct.name,
        ...(!state?.marketingProductId ? { marketingProductId: selectedProduct.id } : {}),
        journeyStage,
        sentiment,
        satisfaction,
        health,
        currentIssues: parse(issues),
        objections: parse(objections),
        manualLockFields: lockJourney ? ["journeyStage"] : [],
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
  };
  return <div className="de-modal-backdrop" onMouseDown={onClose}><section className="de-modal de-product-editor" role="dialog" aria-modal="true" aria-label={state ? t("编辑产品状态") : t("添加产品")} onMouseDown={(event) => event.stopPropagation()}>
    <div className="de-modal-head"><div><h2>{state ? t("编辑产品状态") : t("添加产品关系")}</h2><p>{t("销售阶段、使用满意度和风险独立记录。")}</p></div><button className="de-icon-button" type="button" onClick={onClose}>×</button></div>
    <form className="de-form" onSubmit={submit}><div className="de-form-grid"><label><span>{t("营销资料产品 *")}</span><select value={marketingProductId} onChange={(event) => setMarketingProductId(event.target.value)} disabled={!!state?.marketingProductId} autoFocus><option value="">{t("请选择产品")}</option>{state?.marketingProductId && !products.some((product) => product.id === state.marketingProductId) && <option value={state.marketingProductId}>{state.productName}{t("（已归档）")}</option>}{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label><label><span>{t("旅程阶段")}</span><select value={journeyStage} onChange={(event) => setJourneyStage(event.target.value as JourneyStage)}>{JOURNEY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><label><span>{t("最近态度")}</span><select value={sentiment} onChange={(event) => setSentiment(event.target.value as Sentiment)}>{SENTIMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><label><span>{t("满意度")}</span><select value={satisfaction} onChange={(event) => setSatisfaction(event.target.value as Satisfaction)}>{SATISFACTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><label><span>{t("健康度")}</span><select value={health} onChange={(event) => setHealth(event.target.value as Health)}>{HEALTH_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><label><span>{t("当前问题")}</span><textarea value={issues} onChange={(event) => setIssues(event.target.value)} placeholder={t("用分号分隔")} /></label><label><span>{t("异议")}</span><textarea value={objections} onChange={(event) => setObjections(event.target.value)} placeholder={t("用分号分隔")} /></label></div><fieldset className="de-form-section"><legend>{t("人工锁定")}</legend><div className="de-check-row"><label><input type="checkbox" checked={lockJourney} onChange={(event) => setLockJourney(event.target.checked)} /> {t("锁定产品旅程阶段")}</label></div></fieldset>{error && <p className="de-form-error">{t(error)}</p>}<footer className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose} disabled={saving}>{t("取消")}</button><button className="de-primary-button" disabled={saving || !marketingProductId}>{saving ? t("保存中…") : t("保存状态")}</button></footer></form>
  </section></div>;
}
