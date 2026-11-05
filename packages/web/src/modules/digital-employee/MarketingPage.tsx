import { useI18n } from "../../i18n/index.js";
import { AcquisitionAnalyticsPage } from "./acquisition/AcquisitionAnalyticsPage.js";
import { CampaignsPage } from "./acquisition/CampaignsPage.js";
import { CreationWorkspacePage, type CreationSeed } from "./acquisition/CreationWorkspacePage.js";
import { seedFromAsset, seedFromCampaign } from "./acquisition/creation-seeds.js";
import { MarketingAssetLibraryPage } from "./acquisition/MarketingAssetLibraryPage.js";
import type { EmployeeFocus } from "./focus.js";

interface MarketingPageProps {
  tab: string | null;
  seed?: CreationSeed;
  onNavigate: (tail?: string) => void;
  onOpenCreation: (seed: CreationSeed) => void;
  onOpenSegments: () => void;
  onOpenMaterials: () => void;
  onFocus: (focus: EmployeeFocus | null) => void;
}

const TABS: Array<{ id: string | null; label: string }> = [
  { id: null, label: "活动" },
  { id: "assets", label: "素材" },
  { id: "analytics", label: "效果" },
];

/** Campaigns, assets and results. The creation form is reached from them, for fine-tuning. */
export function MarketingPage({ tab, seed, onNavigate, onOpenCreation, onOpenSegments, onOpenMaterials, onFocus }: MarketingPageProps) {
  const { t } = useI18n();
  return <div className="de-page de-acquisition-page">
    <nav className="de-employee-tabs" aria-label={t("营销")}>
      {TABS.map((item) => <button
        key={item.label}
        className={tab === item.id ? "active" : ""}
        onClick={() => onNavigate(item.id ?? undefined)}
      >{t(item.label)}</button>)}
    </nav>
    {!tab && <CampaignsPage
      onCreate={() => onOpenCreation({})}
      onContinue={(campaign) => onOpenCreation(seedFromCampaign(campaign))}
      onSelect={(campaign) => onFocus({ type: "campaign", id: campaign.id, label: campaign.name })}
    />}
    {tab === "assets" && <MarketingAssetLibraryPage
      onCreate={() => onOpenCreation({})}
      onReuse={(asset) => onOpenCreation(seedFromAsset(asset))}
      onSelect={(asset) => onFocus({ type: "asset", id: asset.id, label: asset.title })}
    />}
    {tab === "analytics" && <AcquisitionAnalyticsPage />}
    {tab === "creation" && <CreationWorkspacePage
      seed={seed}
      onOpenAssets={() => onNavigate("assets")}
      onOpenSegments={onOpenSegments}
      onOpenCampaigns={() => onNavigate()}
      onOpenMarketingMaterials={onOpenMaterials}
    />}
  </div>;
}
