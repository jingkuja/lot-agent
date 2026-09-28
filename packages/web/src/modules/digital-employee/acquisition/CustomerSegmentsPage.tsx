import { useI18n } from "../../../i18n/index.js";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import { HEALTH_LABELS, RELATIONSHIP_LABELS, type AcquisitionInsights, type CustomerSegment, type CustomerSegmentCriteria, type Health, type RelationshipStage } from "../types.js";

export function CustomerSegmentsPage({ onCreateContent }: { onCreateContent: (segment: CustomerSegment) => void }) {
  const { t } = useI18n();
  const [insights, setInsights] = useState<AcquisitionInsights | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setInsights(await api.getAcquisitionInsights()); } catch (reason) { setError(reason instanceof Error ? reason.message : "客群洞察加载失败"); } }, []);
  useEffect(() => { void load(); }, [load]);
  const create = async (input: { name: string; description?: string; criteria: CustomerSegmentCriteria }) => { setSaving(true); try { await api.createCustomerSegment(input); setEditorOpen(false); await load(); } finally { setSaving(false); } };
  const snapshot = async (segment: CustomerSegment) => { await api.snapshotCustomerSegment(segment.id); await load(); };
  return <section className="de-acquisition-workspace">
    <header className="de-acquisition-section-head"><div><p>{t("客群洞察")}</p><h2>{t("从整体群像建立可复用的动态客群")}</h2><span>{t("筛选条件可持续计算；每次活动会固定实际名单快照和排除项。")}</span></div><button className="de-primary-button" onClick={() => setEditorOpen(true)}>{t("＋ 新建动态客群")}</button></header>
    {error && <div className="de-inline-error"><span>{t(error)}</span><button onClick={() => void load()}>{t("重试")}</button></div>}
    {!insights ? <div className="de-state">{t("正在计算客群洞察…")}</div> : <>
      <article className="de-overall-cohort"><div><p>{t("整体群像")}</p><h3>{insights.overall?.summary || t("还没有可分析的客户画像")}</h3><span>{insights.overall ? t("样本日期 {0}", [insights.overall.snapshotDate]) : t("先在客户画像中沉淀事实")}</span></div><div><Metric label={t("客户总数")} value={insights.overall?.metrics.totalProfiles ?? 0} /><Metric label={t("近 7 天活跃")} value={insights.overall?.metrics.activeLast7Days ?? 0} /><Metric label={t("待跟进")} value={insights.overall?.metrics.dueFollowUps ?? 0} /></div></article>
      {insights.segments.length === 0 ? <div className="de-state de-empty-state"><span className="de-empty-icon">◎</span><strong>{t("还没有保存的动态客群")}</strong><p>{t("按关系阶段、区域、标签、产品阶段和风险排除条件建立第一组受众。")}</p><button className="de-primary-button" onClick={() => setEditorOpen(true)}>{t("新建客群")}</button></div> : <div className="de-segment-grid">{insights.segments.map((segment) => <SegmentCard key={segment.id} segment={segment} onSnapshot={() => void snapshot(segment)} onCreate={() => onCreateContent(segment)} />)}</div>}
    </>}
    {editorOpen && <SegmentEditor saving={saving} onClose={() => !saving && setEditorOpen(false)} onSave={create} />}
  </section>;
}

function SegmentCard({ segment, onSnapshot, onCreate }: { segment: CustomerSegment; onSnapshot: () => void; onCreate: () => void }) {
  const { t } = useI18n();
  const metrics = segment.latestSnapshot?.metrics;
  return <article className="de-segment-card"><header><div><span>{t("动态客群")}</span><h3>{segment.name}</h3><p>{segment.description || criteriaText(segment.criteria, t)}</p></div><strong>{metrics?.totalProfiles ?? 0}<small>{t("人")}</small></strong></header><div className="de-segment-breakdown"><span>{t("排除")}<b>{metrics?.excludedProfiles ?? 0}</b></span><span>{t("共同需求")}<b>{metrics?.commonNeeds?.length ?? 0}</b></span><span>{t("主要异议")}<b>{metrics?.commonObjections?.length ?? 0}</b></span></div>{metrics?.topTags?.length ? <div className="de-segment-tags">{metrics.topTags.slice(0, 4).map((item) => <span key={item.label}>{t(item.label)} · {item.count}</span>)}</div> : null}{metrics?.warnings?.map((warning) => <p key={warning} className="de-segment-warning">! {warning}</p>)}<footer><button className="de-secondary-button" onClick={onSnapshot}>{t("重新固定快照")}</button><button className="de-primary-button" onClick={onCreate}>{t("用此客群创作")}</button></footer></article>;
}

function SegmentEditor({ saving, onClose, onSave }: { saving: boolean; onClose: () => void; onSave: (input: { name: string; description?: string; criteria: CustomerSegmentCriteria }) => Promise<void> }) {
  const { t } = useI18n();
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [relationshipStages, setRelationshipStages] = useState<RelationshipStage[]>(["lead", "prospect"]); const [health, setHealth] = useState<Health[]>([]); const [regions, setRegions] = useState(""); const [tags, setTags] = useState(""); const [productName, setProductName] = useState(""); const [activeWithinDays, setActiveWithinDays] = useState("30"); const [excludeAtRisk, setExcludeAtRisk] = useState(true); const [excludeRecently, setExcludeRecently] = useState("7");
  const toggle = <T extends string>(value: T, current: T[], update: (value: T[]) => void) => update(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  const submit = () => onSave({ name, description, criteria: { relationshipStages, health, regions: csv(regions), tags: csv(tags), productName: productName || undefined, activeWithinDays: number(activeWithinDays), excludeAtRisk, excludeRecentlyContactedDays: number(excludeRecently) } });
  return <div className="de-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="de-modal de-segment-editor"><header className="de-modal-head"><div><p className="de-eyebrow">{t("动态客群")}</p><h2>{t("定义可重复计算的筛选条件")}</h2></div><button className="de-icon-button" onClick={onClose}>×</button></header><div className="de-segment-editor-grid"><label><span>{t("客群名称")}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("例如：华东制造业评估客户")} /></label><label><span>{t("客群说明")}</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("这类客户为什么值得持续观察")} /></label><fieldset><legend>{t("关系阶段")}</legend>{(Object.entries(RELATIONSHIP_LABELS) as Array<[RelationshipStage, string]>).map(([value, label]) => <button type="button" key={value} className={relationshipStages.includes(value) ? "active" : ""} onClick={() => toggle(value, relationshipStages, setRelationshipStages)}>{t(label)}</button>)}</fieldset><fieldset><legend>{t("健康度")}</legend>{(Object.entries(HEALTH_LABELS) as Array<[Health, string]>).map(([value, label]) => <button type="button" key={value} className={health.includes(value) ? "active" : ""} onClick={() => toggle(value, health, setHealth)}>{t(label)}</button>)}</fieldset><label><span>{t("区域（逗号分隔）")}</span><input value={regions} onChange={(event) => setRegions(event.target.value)} placeholder={t("华东, 上海")} /></label><label><span>{t("标签（需同时满足）")}</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t("制造业, 重点潜客")} /></label><label><span>{t("关联产品")}</span><input value={productName} onChange={(event) => setProductName(event.target.value)} placeholder={t("可选")} /></label><label><span>{t("近期活跃")}</span><select value={activeWithinDays} onChange={(event) => setActiveWithinDays(event.target.value)}><option value="7">{t("7 天内")}</option><option value="30">{t("30 天内")}</option><option value="90">{t("90 天内")}</option><option value="">{t("不限")}</option></select></label></div><div className="de-segment-safety"><label><input type="checkbox" checked={excludeAtRisk} onChange={(event) => setExcludeAtRisk(event.target.checked)} /> {t("排除有投诉或高风险客户")}</label><label><input type="checkbox" checked={Boolean(excludeRecently)} onChange={(event) => setExcludeRecently(event.target.checked ? "7" : "")} /> {t("排除近")}<input type="number" min="1" max="90" disabled={!excludeRecently} value={excludeRecently} onChange={(event) => setExcludeRecently(event.target.value)} /> {t("天刚联系过的客户")}</label></div><footer className="de-modal-actions"><button className="de-secondary-button" onClick={onClose}>{t("取消")}</button><button className="de-primary-button" disabled={saving || !name.trim()} onClick={() => void submit()}>{saving ? t("正在计算快照…") : t("保存并生成首个快照")}</button></footer></section></div>;
}

function Metric({ label, value }: { label: string; value: number }) {
  const { t } = useI18n(); return <span><strong>{value}</strong>{t(label)}</span>; }
function csv(value: string) { return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean); }
function number(value: string) { return value ? Number(value) : undefined; }
function criteriaText(criteria: CustomerSegmentCriteria, t: ReturnType<typeof useI18n>["t"]) { return [...(criteria.relationshipStages ?? []).map((item) => t(RELATIONSHIP_LABELS[item])), ...(criteria.regions ?? []), ...(criteria.tags ?? [])].join(" · ") || t("所有可分析客户"); }
