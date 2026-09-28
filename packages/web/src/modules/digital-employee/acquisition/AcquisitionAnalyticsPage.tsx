import { useI18n } from "../../../i18n/index.js";
import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import type { AcquisitionAnalytics, DeploymentPlatform } from "../types.js";

const PLATFORM_LABEL: Record<DeploymentPlatform, string> = { moments: "朋友圈", wechat_official: "公众号", channels: "视频号", douyin_kuaishou: "抖音 / 快手", xiaohongshu: "小红书", ad_platform: "广告平台", other: "其他" };

export function AcquisitionAnalyticsPage() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<AcquisitionAnalytics | null>(null); const [error, setError] = useState<string | null>(null);
  const [leadOpen, setLeadOpen] = useState(false);
  useEffect(() => { void api.getAcquisitionAnalytics().then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : "效果数据加载失败")); }, []);
  return <section className="de-acquisition-workspace"><header className="de-acquisition-section-head"><div><p>{t("效果复盘")}</p><h2>{t("跨资产、平台与客群查看真实反馈")}</h2><span>{t("这里只汇总明确记录的投放与平台反馈，不用生成数量冒充业务成果。")}</span></div><button className="de-primary-button" onClick={() => setLeadOpen(true)}>{t("＋ 回流具体咨询者")}</button></header>{error && <div className="de-inline-error"><span>{t(error)}</span></div>}{!data ? <div className="de-state">{t("正在汇总投放效果…")}</div> : <><div className="de-analytics-summary"><Metric label={t("营销资产")} value={data.assets.total} note={`${data.assets.deployed} 项已投放`} /><Metric label={t("累计曝光")} value={data.totals.impressions} note={`${data.totals.deployments} 次平台投放`} /><Metric label={t("累计互动")} value={data.totals.interactions} note={`${data.totals.feedbackCount} 条反馈`} /><Metric label={t("咨询 / 转化")} value={data.totals.conversions} note="可识别线索需回流商机雷达" accent /></div><div className="de-analytics-layout"><article><header><h3>{t("资产构成")}</h3><span>{t("生成与投放分开统计")}</span></header><div className="de-asset-composition"><Bar label={t("文案")} value={data.assets.text} total={data.assets.total} /><Bar label={t("海报 / 图片")} value={data.assets.image} total={data.assets.total} /><Bar label={t("视频")} value={data.assets.video} total={data.assets.total} /></div></article><article><header><h3>{t("平台效果")}</h3><span>{t("按已回填数据汇总")}</span></header>{data.platforms.length === 0 ? <p className="de-analytics-empty">{t("还没有投放反馈。在营销资产库中标记投放并记录曝光、互动与转化后，这里会自动汇总。")}</p> : <table><thead><tr><th>{t("平台")}</th><th>{t("投放")}</th><th>{t("曝光")}</th><th>{t("互动")}</th><th>{t("转化")}</th></tr></thead><tbody>{data.platforms.map((item) => <tr key={`${item.platform}:${item.customPlatform}`}><td>{item.customPlatform || t(PLATFORM_LABEL[item.platform])}</td><td>{item.deployments}</td><td>{format(item.impressions, locale)}</td><td>{format(item.interactions, locale)}</td><td>{format(item.conversions, locale)}</td></tr>)}</tbody></table>}</article></div></>}{leadOpen && <LeadReturnDialog onClose={() => setLeadOpen(false)} />}</section>;
}

function Metric({ label, value, note, accent }: { label: string; value: number; note: string; accent?: boolean }) {
  const { t, locale } = useI18n(); return <article className={accent ? "accent" : ""}><span>{t(label)}</span><strong>{format(value, locale)}</strong><small>{t(note)}</small></article>; }
function Bar({ label, value, total }: { label: string; value: number; total: number }) {
  const { t } = useI18n(); return <div><span>{t(label)}<b>{value}</b></span><i><em style={{ width: `${total ? Math.max(4, value / total * 100) : 0}%` }} /></i></div>; }
function format(value: number, locale = "zh-CN") { return new Intl.NumberFormat(locale, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }

function LeadReturnDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState(""); const [organization, setOrganization] = useState(""); const [productName, setProductName] = useState(""); const [sourceCampaign, setSourceCampaign] = useState(""); const [quote, setQuote] = useState(""); const [saving, setSaving] = useState(false); const [done, setDone] = useState(false); const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true); setError(null);
    try {
      await api.returnAcquisitionLead({
        displayName: displayName.trim(),
        organization: organization.trim() || null,
        sourceCampaign: sourceCampaign.trim() || undefined,
        productName: productName.trim() || undefined,
        quote: quote.trim() || undefined,
      });
      setDone(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "线索回流失败"); }
    finally { setSaving(false); }
  };
  return <div className="de-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="de-modal de-lead-return-dialog"><header className="de-modal-head"><div><p className="de-eyebrow">{t("获客宝 → 商机雷达")}</p><h2>{t("回流具体咨询者")}</h2></div><button className="de-icon-button" onClick={onClose}>×</button></header>{done ? <div className="de-lead-return-done"><span>✓</span><strong>{t("已建档并创建单客跟进行动")}</strong><p>{t("后续联系、话术和结果回填请在商机雷达中完成。")}</p><button className="de-primary-button" onClick={onClose}>{t("完成")}</button></div> : <div className="de-form"><p className="de-field-hint">{t("提交后会创建客户画像、保存活动来源与客户原话，并在商机雷达建立明日首触达行动。")}</p><div className="de-form-grid"><label><span>{t("咨询者姓名")}</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label><span>{t("机构（选填）")}</span><input value={organization} onChange={(event) => setOrganization(event.target.value)} /></label><label><span>{t("来源活动")}</span><input value={sourceCampaign} onChange={(event) => setSourceCampaign(event.target.value)} placeholder={t("活动或资产名称")} /></label><label><span>{t("感兴趣产品")}</span><input value={productName} onChange={(event) => setProductName(event.target.value)} /></label><label className="de-form-full"><span>{t("客户原话 / 咨询内容")}</span><textarea value={quote} onChange={(event) => setQuote(event.target.value)} /></label></div>{error && <p className="de-field-error">{t(error)}</p>}<div className="de-modal-actions"><button className="de-secondary-button" onClick={onClose}>{t("取消")}</button><button className="de-primary-button" disabled={saving || !displayName.trim()} onClick={() => void save()}>{saving ? t("正在建档…") : t("确认回流并创建跟进")}</button></div></div>}</section></div>;
}
