import { useI18n } from "../../../i18n/index.js";
import type { MarketingAsset } from "../types.js";

const TYPE_LABEL = { text: "营销文案", poster: "营销海报", image: "营销图片", video: "营销视频" };

export function MarketingAssetCard({ item, onView, onManage, onReuse, onArchive }: {
  item: MarketingAsset;
  onView: () => void;
  onManage: () => void;
  onReuse: () => void;
  onArchive: () => void;
}) {
  const { t, locale } = useI18n();
  const deployed = item.deployments.filter((entry) => entry.status !== "pending");
  const feedback = item.deployments.flatMap((entry) => entry.feedback);
  const impressions = feedback.reduce((sum, entry) => sum + (entry.impressions ?? 0), 0);
  const conversions = feedback.reduce((sum, entry) => sum + (entry.conversions ?? 0), 0);
  return <article className="de-marketing-asset-card">
    <div className={`de-asset-preview asset-${item.assetType} clickable`} onClick={onView} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onView(); } }} title={t("查看内容详情")}>
      {item.fileUrl && item.assetType === "video" ? <video src={item.fileUrl} controls preload="metadata" onClick={(event) => event.stopPropagation()} /> : item.fileUrl ? <img src={item.fileUrl} alt={item.title} /> : item.assetType === "text" ? <p>{item.content.slice(0, 180)}</p> : <div className={`de-generation-state ${item.generationStatus}`}><span>{item.generationStatus === "failed" ? "!" : "◌"}</span>{item.generationStatus === "failed" ? t("生成失败") : t("正在生成")}</div>}
      <span className="de-asset-type">{t(TYPE_LABEL[item.assetType])}</span>
    </div>
    <div className="de-asset-card-body">
      <div className="de-asset-card-title"><div><h3>{item.title}</h3><p>{item.segmentName || t("公开受众")} · {date(item.createdAt, locale)}</p></div><span className={`deployment-${deployed.length ? "deployed" : "pending"}`}>{deployed.length ? t("已投放") : t("待投放")}</span></div>
      <div className="de-asset-feedback-summary"><span>{t("投放平台")}<strong>{deployed.length}</strong></span><span>{t("曝光")}<strong>{compact(impressions)}</strong></span><span>{t("转化")}<strong>{compact(conversions)}</strong></span></div>
      <div className="de-asset-card-actions">
        <button className="de-secondary-button" onClick={onView}>{t("查看内容")}</button>
        {item.fileUrl && <a className="de-secondary-button" href={item.fileUrl} download>{t("下载")}</a>}
        <button className="de-secondary-button" onClick={onReuse}>{t("复用")}</button>
        <button className="de-primary-button" disabled={item.generationStatus !== "ready"} onClick={onManage}>{t("投放与反馈")}</button>
        <button className="de-icon-button" title={t("归档")} onClick={onArchive}>⋯</button>
      </div>
    </div>
  </article>;
}

function date(value: string, locale = "zh-CN") { return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function compact(value: number) { return value >= 10_000 ? `${(value / 10_000).toFixed(1)}w` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value); }
