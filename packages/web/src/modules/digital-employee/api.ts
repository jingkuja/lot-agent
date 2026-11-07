import { request, type UploadedAttachment } from "../../api/client.js";
import type { EmployeeFocus } from "./focus.js";
import type {
  Assignment, AssignmentDetail, AssignmentFilter, AssignmentInput, AssignmentPage, BoardEntry, ConversationWork, CustomerWork, DecisionAnswer, EmployeeSchedule,
  EmployeeSettings, ProposalResult, ScheduleInput, ScheduleRun, TodayResponse, TodaySummary,
} from "./types.js";
import type {
  CustomerObservation,
  CustomerProductState,
  CustomerProfile,
  MarketingBrandAssets,
  MarketingProduct,
  MarketingProductInput,
  MarketingProductListResponse,
  ProductDocument,
  ProductDocumentList,
  ProductImportCommit,
  ProductImportResult,
  ProductImportStatus,
  ImportDraft,
  CustomerStateChange,
  DigitalEmployeeOverview,
  ManualObservationInput,
  ProductStateUpdateInput,
  ProfileDetailResponse,
  ProfileInput,
  ProfileListResponse,
  ProfileUpdateInput,
  OpportunityListResponse,
  OpportunitySettings,
  OpportunityView,
  CustomerSegment,
  CustomerSegmentCriteria,
  CustomerSegmentSnapshot,
  AcquisitionInsights,
  CampaignRecommendation,
  AcquisitionModelConfiguration,
  MarketingAsset,
  MarketingAssetListResponse,
  DeploymentPlatform,
  AssetDeployment,
  DeploymentFeedback,
  AcquisitionAnalytics,
  MarketingCampaignSummary,
  MarketingCampaignDetail,
  CampaignOpportunity,
} from "./types.js";

/** Every digital employee endpoint. Platform code never calls these. */
export const employeeApi = {
  getEmployeeSettings: () => request<EmployeeSettings>("/digital-employee/settings"),

  saveEmployeeSettings: (input: EmployeeSettings) =>
    request<EmployeeSettings>("/digital-employee/settings", { method: "PUT", body: JSON.stringify(input) }),

  getToday: () => request<TodayResponse>("/digital-employee/today"),

  listSchedules: () => request<{ schedules: EmployeeSchedule[]; runs: ScheduleRun[] }>("/digital-employee/schedules"),

  createSchedule: (input: ScheduleInput) =>
    request<EmployeeSchedule>("/digital-employee/schedules", { method: "POST", body: JSON.stringify(input) }),

  updateSchedule: (id: string, input: ScheduleInput & { version: number }) =>
    request<EmployeeSchedule>(`/digital-employee/schedules/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),

  deleteSchedule: (id: string) => request<{ ok: boolean }>(`/digital-employee/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getScheduleRun: (id: string) => request<ScheduleRun>(`/digital-employee/schedule-runs/${encodeURIComponent(id)}`),

  acknowledgeScheduleRun: (id: string) =>
    request<{ ok: boolean }>(`/digital-employee/schedule-runs/${encodeURIComponent(id)}/acknowledge`, { method: "POST" }),

  getConversationWork: (id: string) => request<ConversationWork>(`/digital-employee/work-log/conversations/${encodeURIComponent(id)}`),

  listAssignments: (filter: AssignmentFilter = {}) => {
    const query = new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const suffix = query.toString();
    return request<AssignmentPage>(`/digital-employee/assignments${suffix ? `?${suffix}` : ""}`);
  },

  createAssignment: (input: AssignmentInput) =>
    request<Assignment>("/digital-employee/assignments", { method: "POST", body: JSON.stringify(input) }),

  getAssignment: (id: string) => request<AssignmentDetail>(`/digital-employee/assignments/${encodeURIComponent(id)}`),

  cancelAssignment: (id: string) => request<Assignment>(`/digital-employee/assignments/${encodeURIComponent(id)}/cancel`, { method: "POST" }),

  retryAssignment: (id: string) => request<Assignment>(`/digital-employee/assignments/${encodeURIComponent(id)}/retry`, { method: "POST" }),

  /** Leave the limit out to keep it; pass null to remove it. */
  resumeAssignment: (id: string, creditLimit?: number | null) => request<Assignment>(`/digital-employee/assignments/${encodeURIComponent(id)}/resume`, {
    method: "POST", body: JSON.stringify(creditLimit === undefined ? {} : { creditLimit }),
  }),

  setAssignmentLimit: (id: string, creditLimit: number | null) => request<Assignment>(`/digital-employee/assignments/${encodeURIComponent(id)}/limit`, {
    method: "PUT", body: JSON.stringify({ creditLimit }),
  }),

  addSubtask: (id: string, goal: string) => request<Assignment>(`/digital-employee/assignments/${encodeURIComponent(id)}/subtasks`, {
    method: "POST", body: JSON.stringify({ goal }),
  }),

  getSubtaskSteps: (id: string, subtaskId: string) => request<Pick<AssignmentDetail, "runs">>(
    `/digital-employee/assignments/${encodeURIComponent(id)}/subtasks/${encodeURIComponent(subtaskId)}`,
  ),

  cancelSubtask: (id: string, subtaskId: string) => request<Assignment>(
    `/digital-employee/assignments/${encodeURIComponent(id)}/subtasks/${encodeURIComponent(subtaskId)}/cancel`, { method: "POST" },
  ),

  retrySubtask: (id: string, subtaskId: string) => request<Assignment>(
    `/digital-employee/assignments/${encodeURIComponent(id)}/subtasks/${encodeURIComponent(subtaskId)}/retry`, { method: "POST" },
  ),

  setSubtaskLimit: (id: string, subtaskLimit: number | null) => request<Assignment>(`/digital-employee/assignments/${encodeURIComponent(id)}/subtask-limit`, {
    method: "PUT", body: JSON.stringify({ subtaskLimit }),
  }),

  getAssignmentBoard: (id: string, before: string) => request<{ entries: BoardEntry[] }>(
    `/digital-employee/assignments/${encodeURIComponent(id)}/board?before=${encodeURIComponent(before)}`,
  ),

  answerDecision: (id: string, answer: DecisionAnswer) => request<Assignment>(`/digital-employee/assignments/decisions/${encodeURIComponent(id)}/answer`, {
    method: "POST", body: JSON.stringify(answer),
  }),

  /** `after` is the last task event this device saw. Without it the answer only gives a cursor to start from. */
  getTodaySummary: (after?: string) => request<TodaySummary>(`/digital-employee/today/summary${after ? `?after=${encodeURIComponent(after)}` : ""}`),

  markBriefRead: (id: string) =>
    request<{ ok: boolean }>(`/digital-employee/today/brief/${encodeURIComponent(id)}/read`, { method: "POST" }),

  confirmProposal: (id: string) => request<ProposalResult>(`/digital-employee/proposals/${encodeURIComponent(id)}/confirm`, { method: "POST" }),

  dismissProposal: (id: string) =>
    request<{ id: string; status: "dismissed" }>(`/digital-employee/proposals/${encodeURIComponent(id)}/dismiss`, { method: "POST" }),

  setConversationFocus: (conversationId: string, focus: Pick<EmployeeFocus, "type" | "id">) =>
    request<EmployeeFocus>(`/digital-employee/conversation-context/${encodeURIComponent(conversationId)}`, {
      method: "PUT",
      body: JSON.stringify(focus),
    }),

  getCustomerWork: (profileId: string) => request<CustomerWork>(`/digital-employee/profiles/${encodeURIComponent(profileId)}/work`),

  getDigitalEmployeeOverview: () => request<DigitalEmployeeOverview>("/digital-employee/overview"),

  saveDigitalEmployeeCohortSchedule: (input: { enabled: boolean; version: number }) =>
    request<DigitalEmployeeOverview["schedule"]>("/digital-employee/overview/schedule", {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  listCustomerProfiles: (
    filters: {
      page?: number;
      limit?: number;
      q?: string;
      relationshipStage?: string;
      health?: string;
      tag?: string;
      status?: string;
    } = {}
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return request<ProfileListResponse>(`/digital-employee/profiles${suffix ? `?${suffix}` : ""}`);
  },

  getCustomerProfile: (id: string) => request<ProfileDetailResponse>(`/digital-employee/profiles/${encodeURIComponent(id)}`),

  createCustomerProfile: (input: ProfileInput) =>
    request<ProfileDetailResponse>("/digital-employee/profiles", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateCustomerProfile: (id: string, input: ProfileUpdateInput) =>
    request<CustomerProfile>(`/digital-employee/profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  archiveCustomerProfile: (id: string, version: number, onOpenTasks?: "cancel" | "keep") =>
    request<CustomerProfile>(`/digital-employee/profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ version, onOpenTasks }),
    }),

  updateCustomerProductState: (profileId: string, productKey: string, input: ProductStateUpdateInput) =>
    request<{ profile: CustomerProfile; productState: CustomerProductState }>(
      `/digital-employee/profiles/${encodeURIComponent(profileId)}/products/${encodeURIComponent(productKey)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    ),

  addCustomerObservation: (profileId: string, input: ManualObservationInput) =>
    request<{
      profile: CustomerProfile;
      observation: CustomerObservation;
      extraction: unknown;
      appliedFields: string[];
      skippedFields: string[];
    }>(`/digital-employee/profiles/${encodeURIComponent(profileId)}/observations`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getCustomerTimeline: (profileId: string) =>
    request<{ observations: CustomerObservation[]; changes: CustomerStateChange[] }>(
      `/digital-employee/profiles/${encodeURIComponent(profileId)}/timeline`
    ),

  clearDigitalEmployeeContext: (conversationId: string) =>
    request<{ ok: boolean }>(`/digital-employee/conversation-context/${encodeURIComponent(conversationId)}`, { method: "DELETE" }),

  listOpportunities: (filters: {
    view: OpportunityView;
    readiness?: string;
    priority?: string;
    opportunityType?: string;
    relationshipStage?: string;
    product?: string;
    suggestedFrom?: string;
    suggestedTo?: string;
  }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    return request<OpportunityListResponse>(`/digital-employee/opportunities?${query.toString()}`);
  },

  discoverOpportunities: () =>
    request<{ runId: string; taskId: string; reused: boolean }>("/digital-employee/opportunities/discover", { method: "POST" }),
  createOpportunityAction: (input: Record<string, unknown>) =>
    request<import("./types.js").OpportunityItem>("/digital-employee/actions", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  decideOpportunity: (id: string, input: Record<string, unknown>) =>
    request<{ opportunityId: string; status: string; actionId?: string }>(`/digital-employee/opportunities/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  updateOpportunityAction: (id: string, input: Record<string, unknown>) =>
    request<import("./types.js").OpportunityItem>(`/digital-employee/actions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  addOpportunityActionResult: (id: string, input: Record<string, unknown>) =>
    request<{ recordId: string; actionId: string; status: string; nextActionId: string | null }>(
      `/digital-employee/actions/${encodeURIComponent(id)}/results`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ),

  getOpportunitySettings: () => request<OpportunitySettings>("/digital-employee/opportunity-settings"),

  saveOpportunitySettings: (input: OpportunitySettings) =>
    request<OpportunitySettings>("/digital-employee/opportunity-settings", {
      method: "PUT",
      body: JSON.stringify({
        enabled: input.enabled, discoveryMode: input.discoveryMode, timezone: input.timezone,
        dailyRunTime: input.dailyRunTime, version: input.version,
      }),
    }),

  listMarketingProducts: (filters: { q?: string; status?: string; page?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return request<MarketingProductListResponse>(`/digital-employee/marketing/products${suffix ? `?${suffix}` : ""}`);
  },

  createMarketingProduct: (input: MarketingProductInput) =>
    request<MarketingProduct>("/digital-employee/marketing/products", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateMarketingProduct: (id: string, input: Partial<MarketingProductInput> & { version: number }) =>
    request<MarketingProduct>(`/digital-employee/marketing/products/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  archiveMarketingProduct: (id: string, version: number) =>
    request<MarketingProduct>(`/digital-employee/marketing/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ version }),
    }),

  listProductDocuments: (productId: string) =>
    request<ProductDocumentList>(`/digital-employee/marketing/products/${encodeURIComponent(productId)}/documents`),

  addProductDocument: (productId: string, assetId: string) =>
    request<ProductDocument>(`/digital-employee/marketing/products/${encodeURIComponent(productId)}/documents`, {
      method: "POST",
      body: JSON.stringify({ assetId }),
    }),

  retryProductDocument: (productId: string, documentId: string) =>
    request<ProductDocument>(
      `/digital-employee/marketing/products/${encodeURIComponent(productId)}/documents/${encodeURIComponent(documentId)}/retry`,
      { method: "POST", body: "{}" },
    ),

  deleteProductDocument: (productId: string, documentId: string) =>
    request<{ ok: boolean }>(
      `/digital-employee/marketing/products/${encodeURIComponent(productId)}/documents/${encodeURIComponent(documentId)}`,
      { method: "DELETE", body: "{}" },
    ),

  importProductDocument: (productId: string, documentId: string) =>
    request<ProductImportStatus>(
      `/digital-employee/marketing/products/${encodeURIComponent(productId)}/documents/${encodeURIComponent(documentId)}/import`,
      { method: "POST", body: "{}" },
    ),

  listProductImports: () => request<{ items: ProductImportStatus[] }>("/digital-employee/marketing/imports"),

  startProductImport: (assetId: string) =>
    request<ProductImportStatus>("/digital-employee/marketing/imports", { method: "POST", body: JSON.stringify({ assetId }) }),

  getProductImport: (id: string) =>
    request<{ status: ProductImportStatus; draft: ImportDraft | null }>(`/digital-employee/marketing/imports/${encodeURIComponent(id)}`),

  retryProductImport: (id: string) =>
    request<ProductImportStatus>(`/digital-employee/marketing/imports/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" }),

  discardProductImport: (id: string) =>
    request<{ ok: boolean }>(`/digital-employee/marketing/imports/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" }),

  commitProductImport: (draftId: string, input: ProductImportCommit) =>
    request<ProductImportResult>(`/digital-employee/marketing/imports/drafts/${encodeURIComponent(draftId)}/commit`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getMarketingBrandAssets: () => request<MarketingBrandAssets | null>("/digital-employee/marketing/brand-assets"),

  saveMarketingBrandAssets: (input: Partial<Pick<MarketingBrandAssets, "tone" | "visualAssets" | "standardCallsToAction">> & { version?: number }) =>
    request<MarketingBrandAssets>("/digital-employee/marketing/brand-assets", {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  listCustomerSegments: () => request<{ items: CustomerSegment[] }>("/digital-employee/acquisition/segments"),

  createCustomerSegment: (input: { name: string; description?: string; criteria: CustomerSegmentCriteria }) =>
    request<CustomerSegment & { latestSnapshot: CustomerSegmentSnapshot }>("/digital-employee/acquisition/segments", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  snapshotCustomerSegment: (id: string) =>
    request<CustomerSegmentSnapshot>(`/digital-employee/acquisition/segments/${encodeURIComponent(id)}/snapshots`, { method: "POST" }),

  getAcquisitionInsights: () => request<AcquisitionInsights>("/digital-employee/acquisition/insights"),

  updateAcquisitionRecommendation: (id: string, status: "adopted" | "ignored") =>
    request<CampaignRecommendation>(`/digital-employee/acquisition/recommendations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  getAcquisitionModelConfiguration: () => request<AcquisitionModelConfiguration>("/digital-employee/acquisition/model-configuration"),

  listMarketingAssets: (filters: { range?: string; assetType?: string; page?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
    return request<MarketingAssetListResponse>(`/digital-employee/acquisition/assets?${query.toString()}`);
  },

  createMarketingAsset: (input: {
    assetType: "copy" | "poster" | "video";
    prompt: string;
    segmentId?: string;
    segmentSnapshotId?: string;
    publicAudience?: string;
    productId: string;
    recommendationId?: string;
    parentAssetId?: string;
    campaignId?: string;
    objective: string;
    channels: string[];
    callToAction: string;
    title?: string;
    durationSeconds?: number;
    modelId?: string;
    knowledgeBaseIds?: string[];
    attachments?: UploadedAttachment[];
    mediaSettings?: { size?: string; n?: number; quality?: string; durationSec?: number; ratio?: string; generate_audio?: boolean };
    input_reference?: string | string[];
    reference_video?: string | string[];
    reference_audio?: string | string[];
    first_frame?: string;
    last_frame?: string;
  }) => request<MarketingAsset>("/digital-employee/acquisition/assets", { method: "POST", body: JSON.stringify(input) }),

  getMarketingAsset: (id: string) => request<MarketingAsset>(`/digital-employee/acquisition/assets/${encodeURIComponent(id)}`),

  archiveMarketingAsset: (id: string) =>
    request<{ assetId: string; status: "archived" }>(`/digital-employee/acquisition/assets/${encodeURIComponent(id)}`, { method: "DELETE" }),

  saveAssetDeployment: (
    assetId: string,
    input: { platform: DeploymentPlatform; customPlatform?: string; status: "pending" | "deployed" | "ended"; deployedAt?: string | null }
  ) =>
    request<AssetDeployment>(`/digital-employee/acquisition/assets/${encodeURIComponent(assetId)}/deployments`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  addDeploymentFeedback: (
    deploymentId: string,
    input: { requestId?: string; impressions?: number | null; interactions?: number | null; conversions?: number | null; feedbackText?: string }
  ) =>
    request<DeploymentFeedback>(`/digital-employee/acquisition/deployments/${encodeURIComponent(deploymentId)}/feedback`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getAcquisitionAnalytics: () => request<AcquisitionAnalytics>("/digital-employee/acquisition/analytics"),

  returnAcquisitionLead: (input: {
    displayName: string;
    organization?: string | null;
    sourceCampaign?: string;
    productName?: string;
    quote?: string;
  }) =>
    request<{ alreadyApplied: boolean; profile: CustomerProfile; action: { id: string; profileId: string; title: string } }>(
      "/digital-employee/acquisition/leads",
      { method: "POST", body: JSON.stringify(input) }
    ),

  listMarketingCampaigns: (filters: { status?: string; page?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
    return request<{ items: MarketingCampaignSummary[]; total: number; page: number; limit: number }>(
      `/digital-employee/acquisition/campaigns?${query.toString()}`
    );
  },

  createMarketingCampaign: (input: {
    name: string;
    objective: string;
    channels: string[];
    callToAction: string;
    productId: string;
    segmentId?: string;
    segmentSnapshotId?: string;
    publicAudience?: string;
  }) => request<MarketingCampaignDetail>("/digital-employee/acquisition/campaigns", { method: "POST", body: JSON.stringify(input) }),

  getMarketingCampaign: (id: string) => request<MarketingCampaignDetail>(`/digital-employee/acquisition/campaigns/${encodeURIComponent(id)}`),

  updateMarketingCampaign: (
    id: string,
    input: {
      name?: string;
      objective?: string;
      channels?: string[];
      callToAction?: string;
      status?: string;
      selectedAssets?: Partial<Record<"copy" | "poster" | "video", string | null>>;
    }
  ) =>
    request<MarketingCampaignDetail>(`/digital-employee/acquisition/campaigns/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  listCampaignOpportunities: (status?: string) =>
    request<{ items: CampaignOpportunity[]; total: number }>(
      `/digital-employee/acquisition/campaign-opportunities${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),

  acceptCampaignOpportunity: (id: string) =>
    request<MarketingCampaignDetail>(`/digital-employee/acquisition/campaign-opportunities/${encodeURIComponent(id)}/accept`, { method: "POST" }),

  dismissCampaignOpportunity: (id: string) =>
    request<{ opportunityId: string; status: string }>(`/digital-employee/acquisition/campaign-opportunities/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
    }),
};
