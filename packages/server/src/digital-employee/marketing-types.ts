export interface MarketingFact {
  statement: string;
  evidence?: string;
}

export interface MarketingObjection {
  objection: string;
  response: string;
}

export interface MarketingBenefit {
  title: string;
  description?: string;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface MarketingCaseMaterial {
  title: string;
  summary: string;
  result?: string;
  assetUrl?: string;
}

export interface MarketingVisualAsset {
  name: string;
  url: string;
  type?: string;
}

export interface MarketingProduct {
  id: string;
  userId: string;
  name: string;
  positioning: string;
  coreValues: string[];
  verifiableFacts: MarketingFact[];
  commonObjections: MarketingObjection[];
  currentBenefits: MarketingBenefit[];
  prohibitedExpressions: string[];
  caseMaterials: MarketingCaseMaterial[];
  status: "active" | "archived";
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketingBrandAssets {
  id: string;
  userId: string;
  tone: string[];
  visualAssets: MarketingVisualAsset[];
  standardCallsToAction: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MarketingProductInput {
  name: string;
  positioning?: string;
  coreValues?: string[];
  verifiableFacts?: MarketingFact[];
  commonObjections?: MarketingObjection[];
  currentBenefits?: MarketingBenefit[];
  prohibitedExpressions?: string[];
  caseMaterials?: MarketingCaseMaterial[];
}

export interface MarketingProductUpdateInput extends Partial<MarketingProductInput> {
  version: number;
}

export interface MarketingBrandAssetsInput {
  tone?: string[];
  visualAssets?: MarketingVisualAsset[];
  standardCallsToAction?: string[];
  version?: number;
}

export interface MarketingProductListFilters {
  query?: string;
  status?: "active" | "archived";
  page: number;
  limit: number;
}

export interface MarketingProductListResult {
  items: MarketingProduct[];
  page: number;
  limit: number;
  total: number;
}
