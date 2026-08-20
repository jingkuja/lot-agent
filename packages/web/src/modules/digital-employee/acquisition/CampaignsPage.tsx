import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import type { CampaignOpportunity, MarketingCampaignDetail, MarketingCampaignSummary } from "../types.js";

export function CampaignsPage({ onCreate, onContinue }: {
  onCreate: () => void;
  onContinue: (campaign: MarketingCampaignSummary) => void;
}) {
  const [items, setItems] = useState<MarketingCampaignSummary[]>([]);
  const [opportunities, setOpportunities] = useState<CampaignOpportunity[]>([]);
  const [detail, setDetail] = useState<MarketingCampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [campaigns, opportunityResult] = await Promise.all([
        api.listMarketingCampaigns({ limit: 50 }),
        api.listCampaignOpportunities(),
      ]);
      setItems(campaigns.items);
      setOpportunities(opportunityResult.items);
      if (detail) setDetail(await api.getMarketingCampaign(detail.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "活动加载失败"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const open = async (id: string) => {
    const next = await api.getMarketingCampaign(id);
    setDetail(next); setName(next.name);
  };

  const saveName = async () => {
    if (!detail || !name.trim()) return;
    const next = await api.updateMarketingCampaign(detail.id, { name: name.trim() });
    setDetail(next);
    setItems((current) => current.map((item) => item.id === next.id ? next : item));
  };

  const selectVersion = async (kind: "copy" | "poster" | "video", assetId: string) => {
    if (!detail) return;
    const next = await api.updateMarketingCampaign(detail.id, { selectedAssets: { [kind]: assetId } });
    setDetail(next);
  };

  const accept = async (item: CampaignOpportunity) => {
    const campaign = await api.acceptCampaignOpportunity(item.id);
    setItems((current) => [campaign, ...current.filter((entry) => entry.id !== campaign.id)]);
    setOpportunities((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "accepted", campaignId: campaign.id } : entry));
    setDetail(campaign); setName(campaign.name);
  };

  const dismiss = async (item: CampaignOpportunity) => {
    await api.dismissCampaignOpportunity(item.id);
    setOpportunities((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "dismissed" } : entry));
  };

  const suggested = opportunities.filter((item) => item.status === "suggested");

  return <section className="de-acquisition-workspace" aria-label="营销活动">
    <header className="de-acquisition-section-head"><div><p>营销活动</p><h2>把一次客群营销的简报、素材和结果放在一起</h2><span>采纳客群机会会创建活动；文案、海报和视频属于同一活动。</span></div><button className="de-primary-button" onClick={onCreate}>＋ 去创作工作台</button></header>
    {error && <div className="de-inline-error"><span>{error}</span><button onClick={() => void load()}>重试</button></div>}
    {suggested.length > 0 && <div className="de-campaign-opportunities"><h3>待判断的客群机会</h3><div className="de-campaign-opportunity-list">{suggested.map((item) => <article key={item.id}><div><strong>{item.title}</strong><p>{item.theme} · {item.productName || "未关联产品"} · {item.audienceDescription || "已确认客群"}</p></div><div className="de-campaign-opportunity-actions"><button className="de-primary-button" onClick={() => void accept(item)}>采纳并创建活动</button><button className="de-secondary-button" onClick={() => void dismiss(item)}>忽略</button></div></article>)}</div></div>}
    {loading ? <div className="de-state">正在读取营销活动…</div> : items.length === 0 ? <div className="de-state de-empty-state"><span className="de-empty-icon">▣</span><strong>还没有营销活动</strong><p>从创作工作台首次生成，或采纳一条客群机会。</p><button className="de-primary-button" onClick={onCreate}>开始创作</button></div> :
      <div className="de-campaign-layout">
        <div className="de-campaign-list">{items.map((item) => <button key={item.id} className={detail?.id === item.id ? "active" : ""} onClick={() => void open(item.id)}><strong>{item.name}</strong><small>{item.productName || "未选产品"} · {item.assetCount} 项素材 · {item.resultCount} 条结果</small></button>)}</div>
        {detail && <article className="de-campaign-detail">
          <header><div><p>{detail.status === "draft" ? "草稿" : detail.status === "active" ? "进行中" : detail.status === "completed" ? "已完成" : "已归档"}</p><div className="de-campaign-name-row"><input value={name} onChange={(event) => setName(event.target.value)} /><button className="de-secondary-button" onClick={() => void saveName()}>保存名称</button></div></div><button className="de-primary-button" onClick={() => onContinue(detail)}>继续创作此活动</button></header>
          <p className="de-campaign-brief-line">{detail.audienceDescription || "公开/已确认受众"} · {detail.objective} · {detail.callToAction}</p>
          <div className="de-campaign-result-bar">曝光 {detail.results.impressions} · 互动 {detail.results.interactions} · 转化 {detail.results.conversions} · 线索 {detail.results.leads}</div>
          {(["copy", "poster", "video"] as const).map((kind) => <section key={kind}><h3>{kind === "copy" ? "文案版本" : kind === "poster" ? "海报版本" : "视频版本"}</h3>{detail.assets[kind].length === 0 ? <p>尚未生成</p> : <div className="de-version-pills">{detail.assets[kind].map((asset) => <button key={asset.id} className={detail.selectedAssets[kind] === asset.id ? "active" : ""} onClick={() => void selectVersion(kind, asset.id)}>v{asset.version}{detail.selectedAssets[kind] === asset.id ? " · 选用" : ""}</button>)}</div>}{detail.selectedAssets[kind] && kind === "copy" && <pre className="de-campaign-copy-preview">{detail.assets.copy.find((item) => item.id === detail.selectedAssets.copy)?.content}</pre>}</section>)}
        </article>}
      </div>}
  </section>;
}
