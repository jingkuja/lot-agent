import type { Migration } from "../migration-runner.js";
import { baseline } from "./0001-baseline.js";
import { messageSeq } from "./0002-message-seq.js";
import { conversationRunLease } from "./0003-conversation-run-lease.js";
import { digitalEmployeeProfile } from "./0004-digital-employee-profile.js";
import { digitalEmployeeProfileChangeDraft } from "./0005-digital-employee-profile-change-draft.js";
import { customerRegion } from "./0006-customer-region.js";
import { uploadOriginalName } from "./0007-upload-original-name.js";

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
];
