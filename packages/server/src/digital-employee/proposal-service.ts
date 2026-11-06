import type { Pool } from "pg";
import type { CustomerAcquisitionService } from "./acquisition-service.js";
import { ConversationActionDrafts } from "./conversation-drafts.js";
import { ConflictError, InputError, NotFoundError } from "./errors.js";
import type { OpportunityService } from "./opportunity-service.js";
import { PRODUCT_IMPORT_KIND } from "./product-import.js";

export interface PendingProposal {
  id: string;
  kind: string;
  /** Customer records and profile changes need a choice, so their cards return to the chat. */
  confirmable: boolean;
  conversationId: string | null;
  preview: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export interface ConfirmResult {
  id: string;
  kind: string;
  alreadyApplied: boolean;
  entityId: string | null;
  managementUrl: string | null;
}

type Commit = { alreadyApplied?: boolean; entityId?: string | null; managementUrl?: string };

const CAPTURE_KIND = "customer_capture";
const PROFILE_CHANGE_KIND = "profile_change";
const CUSTOMER_DRAFT_TABLES = ["de_customer_capture_drafts", "de_customer_profile_change_drafts"] as const;
const LIST_LIMIT = 30;

/** One entry point for every proposal; commits stay in the services that own them. */
export class ProposalService {
  private readonly drafts: ConversationActionDrafts;
  private readonly commits: Record<string, (userId: string, draftId: string) => Promise<Commit>>;

  constructor(
    private readonly pool: Pool,
    opportunities: Pick<OpportunityService, "commitFollowUpAction" | "commitFollowUpResult">,
    acquisition: Pick<CustomerAcquisitionService,
      "commitCustomerSegment" | "commitMarketingCampaign" | "commitAssetDeployment" | "commitDeploymentFeedback" | "commitCampaignResult">,
  ) {
    this.drafts = new ConversationActionDrafts(pool);
    this.commits = {
      follow_up_action: (userId, id) => opportunities.commitFollowUpAction(userId, id),
      follow_up_result: (userId, id) => opportunities.commitFollowUpResult(userId, id),
      customer_segment: (userId, id) => acquisition.commitCustomerSegment(userId, id),
      marketing_campaign: (userId, id) => acquisition.commitMarketingCampaign(userId, id),
      asset_deployment: (userId, id) => acquisition.commitAssetDeployment(userId, id),
      deployment_feedback: (userId, id) => acquisition.commitDeploymentFeedback(userId, id),
      campaign_result: (userId, id) => acquisition.commitCampaignResult(userId, id),
    };
  }

  async listPending(userId: string): Promise<PendingProposal[]> {
    const [drafts, captures, changes] = await Promise.all([
      this.drafts.listOpen(userId, LIST_LIMIT),
      this.pool.query(
        `SELECT id, conversation_id, raw_text, proposed_observation, ambiguities, created_at, expires_at
         FROM de_customer_capture_drafts
         WHERE user_id=$1 AND status='awaiting_confirmation' AND expires_at > now()
         ORDER BY created_at DESC LIMIT $2`,
        [userId, LIST_LIMIT]
      ),
      this.pool.query(
        `SELECT id, conversation_id, operation, customer_mention, proposed_patch, risks, created_at, expires_at
         FROM de_customer_profile_change_drafts
         WHERE user_id=$1 AND status='awaiting_confirmation' AND expires_at > now()
         ORDER BY created_at DESC LIMIT $2`,
        [userId, LIST_LIMIT]
      ),
    ]);
    const known = drafts.filter((draft) => this.commits[draft.kind] || draft.kind === PRODUCT_IMPORT_KIND).map((draft): PendingProposal => ({
      id: draft.id, kind: draft.kind, confirmable: Boolean(this.commits[draft.kind]), conversationId: draft.conversationId,
      preview: draft.preview, createdAt: draft.createdAt, expiresAt: draft.expiresAt,
    }));
    const captured = captures.rows.map((row): PendingProposal => ({
      id: row.id, kind: CAPTURE_KIND, confirmable: false, conversationId: row.conversation_id ?? null,
      preview: {
        customerMention: captureMention(row.proposed_observation),
        excerpt: String(row.raw_text ?? "").slice(0, 200),
        ambiguities: row.ambiguities ?? [],
      },
      createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    }));
    const changed = changes.rows.map((row): PendingProposal => ({
      id: row.id, kind: PROFILE_CHANGE_KIND, confirmable: false, conversationId: row.conversation_id ?? null,
      preview: {
        customerMention: row.customer_mention, operation: row.operation,
        fields: Object.keys(row.proposed_patch ?? {}), risks: row.risks ?? [],
      },
      createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    }));
    return [...known, ...captured, ...changed].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Commits are idempotent, so a second confirmation reports the first one's outcome. */
  async confirm(userId: string, id: string): Promise<ConfirmResult> {
    const draft = await this.drafts.find(userId, id);
    if (!draft) {
      if (await this.ownsCustomerDraft(userId, id)) throw new InputError("这项需要先在对话里选择");
      throw new NotFoundError("未找到待确认事项");
    }
    const commit = this.commits[draft.kind];
    if (!commit) throw new InputError("这项需要先在对话里选择");
    const result = await commit(userId, id);
    return {
      id, kind: draft.kind,
      alreadyApplied: result.alreadyApplied === true,
      entityId: result.entityId ?? null,
      managementUrl: result.managementUrl ?? null,
    };
  }

  async dismiss(userId: string, id: string): Promise<{ id: string; status: "dismissed" }> {
    const draft = await this.drafts.find(userId, id);
    if (draft) {
      if (draft.status === "dismissed" || await this.drafts.dismiss(userId, id)) {
        if (draft.kind === PRODUCT_IMPORT_KIND) await this.discardImportFile(userId, id);
        return { id, status: "dismissed" };
      }
      throw new ConflictError(draft.status === "applied" ? "这项已经确认过了" : "这项确认正在处理，请稍后刷新");
    }
    for (const table of CUSTOMER_DRAFT_TABLES) {
      const { rows } = await this.pool.query(
        `UPDATE ${table} SET status='dismissed', updated_at=now()
         WHERE id=$1 AND user_id=$2 AND status IN ('prepared','awaiting_confirmation') RETURNING id`,
        [id, userId]
      );
      if (rows[0]) return { id, status: "dismissed" };
      const current = await this.pool.query(`SELECT status FROM ${table} WHERE id=$1 AND user_id=$2`, [id, userId]);
      if (current.rows[0]?.status === "dismissed") return { id, status: "dismissed" };
      if (current.rows[0]) throw new ConflictError("这项已经处理过了");
    }
    throw new NotFoundError("未找到待确认事项");
  }

  /** A file dropped for an import that was turned down belongs to no product, so nothing keeps it. */
  private async discardImportFile(userId: string, draftId: string): Promise<void> {
    await this.pool.query(
      `UPDATE marketing_product_documents
       SET import_status = 'none', updated_at = now(),
           deleted_at = CASE WHEN product_id IS NULL THEN now() ELSE deleted_at END,
           parsed_text = CASE WHEN product_id IS NULL THEN NULL ELSE parsed_text END
       WHERE import_draft_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [draftId, userId]
    );
  }

  private async ownsCustomerDraft(userId: string, id: string): Promise<boolean> {
    for (const table of CUSTOMER_DRAFT_TABLES) {
      const { rows } = await this.pool.query(`SELECT 1 FROM ${table} WHERE id=$1 AND user_id=$2`, [id, userId]);
      if (rows[0]) return true;
    }
    return false;
  }
}

function captureMention(observation: unknown): string {
  const capture = (observation as { capture?: { customerMention?: unknown } } | null)?.capture;
  return typeof capture?.customerMention === "string" ? capture.customerMention : "";
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}
