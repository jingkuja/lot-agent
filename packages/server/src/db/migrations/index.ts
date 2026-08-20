import type { Migration } from "../migration-runner.js";
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
];
