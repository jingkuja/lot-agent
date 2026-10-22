import { marketingAutomaticCreation } from "./0040-marketing-automatic-creation.js";
import { marketingReferenceAnalysis } from "./0039-marketing-reference-analysis.js";
import { feishuPersonalChannel } from "./0038-feishu-personal-channel.js";
import { virtualPayment } from "./0033-virtual-payment.js";
import { marketingVideoProjects } from "./0036-marketing-video-projects.js";
import { agentRunState } from "./0034-agent-run-state.js";
import { klingVoiceTasks } from "./0035-kling-voice-tasks.js";
import { conversationProjects } from "./0031-conversation-projects.js";
import { knowledgeReviewFixes } from "./0030-knowledge-review-fixes.js";
import { knowledgeAccess } from "./0029-knowledge-access.js";
import { knowledgeIndexSpaces } from "./0028-knowledge-index-spaces.js";
import { knowledgeManagementCompletion } from "./0027-knowledge-management-completion.js";
import { knowledgeIndex } from "./0026-knowledge-index.js";
import { knowledgeJobs } from "./0025-knowledge-jobs.js";
import { knowledgeFoundation } from "./0024-knowledge-foundation.js";
import type { Migration } from "../migration-runner.js";
import { feishuIntegration } from "./0037-feishu.js";
import { baseline } from "./0001-baseline.js";
import { messageSeq } from "./0002-message-seq.js";
import { conversationRunLease } from "./0003-conversation-run-lease.js";
import { digitalEmployeeProfile } from "./0004-digital-employee-profile.js";
import { digitalEmployeeProfileChangeDraft } from "./0005-digital-employee-profile-change-draft.js";
import { customerRegion } from "./0006-customer-region.js";
import { uploadOriginalName } from "./0007-upload-original-name.js";
import { customerCohortSnapshot } from "./0008-customer-cohort-snapshot.js";
import { cohortGenerationMethod } from "./0009-cohort-generation-method.js";
import { digitalEmployeeFollowUpCopy } from "./0010-digital-employee-follow-up-copy.js";
import { marketingMaterials } from "./0011-marketing-materials.js";
import { opportunityAdvisor } from "./0012-opportunity-advisor.js";
import { customerAcquisition } from "./0013-customer-acquisition.js";
import { conversationWorkflows } from "./0014-conversation-workflows.js";
import { campaignSelectedAssets } from "./0015-campaign-selected-assets.js";
import { customerProductMarketingLink } from "./0016-customer-product-marketing-link.js";
import { repeatableManualOpportunityDiscovery } from "./0017-repeatable-manual-opportunity-discovery.js";
import { managedNewApiKey } from "./0018-managed-new-api-key.js";
import { userPhone } from "./0019-user-phone.js";
import { cohortAutomationSettings } from "./0020-cohort-automation-settings.js";
import { marketingProductFaqNotes } from "./0021-marketing-product-faq-notes.js";
import { userWechat } from "./0022-user-wechat.js";
import { imageShare } from "./0023-image-share.js";

// Static array (no fs scan — dynamic directory scanning isn't reliable once
// this ships through tsup's bundling). To add a migration: create
// `NNNN-name.ts` exporting a `Migration`, import it here, and append it.
export const migrations: Migration[] = [
  baseline,
  messageSeq,
  conversationRunLease,
  digitalEmployeeProfile,
  digitalEmployeeProfileChangeDraft,
  customerRegion,
  uploadOriginalName,
  customerCohortSnapshot,
  cohortGenerationMethod,
  digitalEmployeeFollowUpCopy,
  marketingMaterials,
  opportunityAdvisor,
  customerAcquisition,
  conversationWorkflows,
  campaignSelectedAssets,
  customerProductMarketingLink,
  repeatableManualOpportunityDiscovery,
  managedNewApiKey,
  userPhone,
  cohortAutomationSettings,
  marketingProductFaqNotes,
  userWechat,
  imageShare,
  knowledgeFoundation,
  knowledgeJobs,
  knowledgeIndex,
  knowledgeManagementCompletion,
  knowledgeIndexSpaces,
  knowledgeAccess,
  knowledgeReviewFixes,
  conversationProjects,
  virtualPayment,
  agentRunState,
  klingVoiceTasks,
  marketingVideoProjects,
  feishuIntegration,
  feishuPersonalChannel,
  marketingReferenceAnalysis,
  marketingAutomaticCreation,
  marketingShotDurations,
  marketingTextOperations,
  marketingAnalysisRetention,
  marketingResultRecovery,
  marketingAnalysisUploads,
  marketingVideoQueue,
  marketingPrivateMaterials,
  deploymentFeedbackRequestId,
  marketingUnknownRelease,
  marketingTextOperationKinds,
  taskErrorCode,
  digitalTwinVoices,
  marketingShotRevisions,
  marketingTextCancelled,
  marketingVideoNarrations,
  digitalPresenter,
  marketingClipGatewayFailures,
];
import { marketingShotDurations } from "./0041-marketing-shot-durations.js";

import { marketingTextOperations } from "./0042-marketing-text-operations.js";
import { marketingAnalysisRetention } from "./0043-marketing-analysis-retention.js";
import { marketingResultRecovery } from "./0044-marketing-result-recovery.js";
import { marketingAnalysisUploads } from "./0045-marketing-analysis-uploads.js";
import { marketingVideoQueue } from "./0046-marketing-video-queue.js";
import { marketingPrivateMaterials } from "./0047-marketing-private-materials.js";
import { deploymentFeedbackRequestId } from "./0048-deployment-feedback-request-id.js";
import { marketingUnknownRelease } from "./0049-marketing-unknown-release.js";
import { marketingTextOperationKinds } from "./0050-marketing-text-operation-kinds.js";
import { taskErrorCode } from "./0051-task-error-code.js";
import { digitalTwinVoices } from "./0052-digital-twin-voices.js";
import { marketingShotRevisions } from "./0053-marketing-shot-revisions.js";
import { marketingTextCancelled } from "./0054-marketing-text-cancelled.js";
import { marketingVideoNarrations } from "./0055-marketing-video-narrations.js";
import { digitalPresenter } from "./0056-digital-presenter.js";
import { marketingClipGatewayFailures } from "./0057-marketing-clip-gateway-failures.js";
