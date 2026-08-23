import { useState } from "react";
import type { CampaignRecommendation, CustomerSegment, MarketingAsset, MarketingCampaignSummary } from "../types.js";
import { MarketingAssetLibraryPage } from "./MarketingAssetLibraryPage.js";
import { DailyRecommendationsPage } from "./DailyRecommendationsPage.js";
import { CreationWorkspacePage, type CreationSeed } from "./CreationWorkspacePage.js";
import { CustomerSegmentsPage } from "./CustomerSegmentsPage.js";
import { AcquisitionAnalyticsPage } from "./AcquisitionAnalyticsPage.js";
import { CampaignsPage } from "./CampaignsPage.js";

type Workspace = "assets" | "recommendations" | "creation" | "campaigns" | "segments" | "analytics";

const WORKSPACES: Array<{ id: Workspace; label: string; description: string }> = [
  { id: "assets", label: "营销资产库", description: "内容与投放" },
  { id: "recommendations", label: "每日推荐", description: "AI 机会建议" },
  { id: "creation", label: "创作工作台", description: "主动生成" },
  { id: "campaigns", label: "营销活动", description: "简报与版本" },
  { id: "segments", label: "客群洞察", description: "分群与快照" },
  { id: "analytics", label: "效果复盘", description: "跨平台反馈" },
];

export function CustomerAcquisitionPage({ onOpenChat, onOpenMarketingMaterials }: { onOpenChat?: () => void; onOpenMarketingMaterials?: () => void }) {
  const [workspace, setWorkspace] = useState<Workspace>("assets");
  const [seed, setSeed] = useState<CreationSeed | undefined>();

  const startCreation = (next: CreationSeed) => {
    setSeed({ ...next, nonce: Date.now() });
    setWorkspace("creation");
  };

  const fromRecommendation = (item: CampaignRecommendation) => startCreation({
    recommendationId: item.id,
    segmentId: item.segmentId ?? undefined,
    productId: item.productId ?? undefined,
    publicAudience: item.segmentId ? undefined : item.targetSegmentDescription,
    title: item.theme,
    prompt: [item.theme, item.creativeDirection, ...item.corePoints].filter(Boolean).join("；"),
    channels: item.suggestedChannels,
    assetType: item.type === "copy" ? "copy" : item.type === "poster" ? "poster" : "video",
    durationSeconds: item.durationSeconds === 10 ? 10 : 15,
  });

  const reuseAsset = (item: MarketingAsset) => startCreation({
    parentAssetId: item.id,
    campaignId: item.campaignId ?? undefined,
    title: `${item.title} · 新版本`,
    prompt: item.assetType === "text" ? `参考以下历史文案的主题和结构生成新版本，但不要直接照抄：\n${item.content}` : `基于“${item.title}”延续主题，生成一个差异化新版本。`,
    assetType: item.assetType === "video" ? "video" : item.assetType === "text" ? "copy" : "poster",
  });

  const continueCampaign = (item: MarketingCampaignSummary) => startCreation({
    campaignId: item.id,
    title: item.name,
    productId: item.productId ?? undefined,
    channels: item.channels,
  });

  const fromSegment = (item: CustomerSegment) => startCreation({ segmentId: item.id, title: `${item.name}营销内容` });

  return <div className="de-page de-acquisition-page">
    <header className="de-acquisition-header">
      <div>
        <p className="de-eyebrow">数字员工 / 获客宝</p>
        <h1>获客宝</h1>
        <p>看懂整体客群，匹配已确认产品资料，生成可管理、可投放、可复盘的营销内容。</p>
      </div>
      <div className="de-acquisition-header-actions">
        {onOpenChat && <button type="button" className="de-secondary-button" onClick={onOpenChat}>与获客宝对话</button>}
        <div className="de-acquisition-scope"><span>经营对象</span><strong>客群 / 公开受众</strong><small>不使用单个客户隐私</small></div>
      </div>
    </header>

    <nav className="de-acquisition-tabs" aria-label="获客宝工作区">
      {WORKSPACES.map((item) => <button key={item.id} className={workspace === item.id ? "active" : ""} onClick={() => setWorkspace(item.id)}>
        <strong>{item.label}</strong><small>{item.description}</small>
      </button>)}
    </nav>

    {workspace === "assets" && <MarketingAssetLibraryPage onReuse={reuseAsset} onCreate={() => startCreation({})} />}
    {workspace === "recommendations" && <DailyRecommendationsPage onCreate={fromRecommendation} />}
    {workspace === "creation" && <CreationWorkspacePage seed={seed} onOpenAssets={() => setWorkspace("assets")} onOpenSegments={() => setWorkspace("segments")} onOpenCampaigns={() => setWorkspace("campaigns")} onOpenMarketingMaterials={onOpenMarketingMaterials} />}
    {workspace === "campaigns" && <CampaignsPage onCreate={() => startCreation({})} onContinue={continueCampaign} />}
    {workspace === "segments" && <CustomerSegmentsPage onCreateContent={fromSegment} />}
    {workspace === "analytics" && <AcquisitionAnalyticsPage />}
  </div>;
}
