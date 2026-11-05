import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ConflictError, InputError, NotFoundError } from "./errors.js";

/** Proposals now wait on the today page, so they outlive the conversation that made them. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** A claim older than this lost its process; the commit it guarded may run again. */
const CLAIM_LEASE = "5 minutes";
const OPEN = "status IN ('prepared','awaiting_confirmation')";

export interface ConversationActionDraft {
  id: string;
  userId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  featureScope: string;
  kind: string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  question: string | null;
  options: string[];
  status: "prepared" | "awaiting_confirmation" | "applied" | "expired" | "dismissed";
  appliedEntityId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface NewConversationDraft {
  userId: string;
  conversationId?: string;
  sourceMessageId?: string;
  featureScope: string;
  kind: string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  question: string;
  options: string[];
  status?: "prepared" | "awaiting_confirmation";
}

export interface DraftCommit<Done, Fresh> {
  /** The draft was already applied, here or by a request that won the race. */
  applied(draft: ConversationActionDraft): Done;
  apply(draft: ConversationActionDraft): Promise<Fresh>;
}

/** Prepare/commit payloads for conversation write tools; the today page reads the same rows. */
export class ConversationActionDrafts {
  constructor(private readonly pool: Pool) {}

  async create(row: NewConversationDraft): Promise<ConversationActionDraft> {
    const { rows } = await this.pool.query(
      `INSERT INTO de_conversation_action_drafts
        (id, user_id, conversation_id, source_message_id, feature_scope, kind, payload, preview, question, options, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12)
       RETURNING *`,
      [
        randomUUID(), row.userId, row.conversationId ?? null, row.sourceMessageId ?? null,
        row.featureScope, row.kind, JSON.stringify(row.payload), JSON.stringify(row.preview),
        row.question, JSON.stringify(row.options), row.status ?? "awaiting_confirmation",
        new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
      ]
    );
    return toDraft(rows[0]);
  }

  async get(userId: string, draftId: string, kind: string): Promise<ConversationActionDraft> {
    const { rows } = await this.pool.query(
      `SELECT * FROM de_conversation_action_drafts WHERE id=$1 AND user_id=$2 AND kind=$3`,
      [draftId, userId, kind]
    );
    if (!rows[0]) throw new NotFoundError("未找到待确认草稿");
    const draft = toDraft(rows[0]);
    if (draft.status === "applied") return draft;
    if (draft.status !== "awaiting_confirmation" && draft.status !== "prepared") {
      throw new InputError("该草稿已失效，请重新准备");
    }
    if (Date.parse(draft.expiresAt) <= Date.now()) throw new InputError("确认草稿已过期，请重新准备");
    return draft;
  }

  /**
   * Applies a draft at most once. The chat card and the today page can confirm the same
   * draft, so the writer claims the row first and a loser reports the outcome instead of
   * writing again. A failed commit gives the claim back so the user can retry.
   */
  async commit<Done, Fresh>(userId: string, draftId: string, kind: string, handlers: DraftCommit<Done, Fresh>): Promise<Done | Fresh> {
    const draft = await this.get(userId, draftId, kind);
    if (draft.status === "applied") return handlers.applied(draft);
    const { rows } = await this.pool.query(
      `UPDATE de_conversation_action_drafts SET claimed_at = now()
       WHERE id=$1 AND user_id=$2 AND ${OPEN}
         AND (claimed_at IS NULL OR claimed_at < now() - interval '${CLAIM_LEASE}')
       RETURNING id`,
      [draftId, userId]
    );
    if (!rows[0]) {
      const current = await this.get(userId, draftId, kind);
      if (current.status === "applied") return handlers.applied(current);
      throw new ConflictError("这项确认正在处理，请稍后刷新");
    }
    try {
      return await handlers.apply(draft);
    } catch (error) {
      await this.pool.query(
        `UPDATE de_conversation_action_drafts SET claimed_at = NULL WHERE id=$1 AND user_id=$2 AND ${OPEN}`,
        [draftId, userId]
      ).catch(() => {});
      throw error;
    }
  }

  async find(userId: string, draftId: string): Promise<ConversationActionDraft | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM de_conversation_action_drafts WHERE id=$1 AND user_id=$2`,
      [draftId, userId]
    );
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async listOpen(userId: string, limit: number): Promise<ConversationActionDraft[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM de_conversation_action_drafts
       WHERE user_id=$1 AND ${OPEN} AND expires_at > now()
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows.map(toDraft);
  }

  /** False when a commit holds the draft or it has already left the open states. */
  async dismiss(userId: string, draftId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `UPDATE de_conversation_action_drafts SET status='dismissed', updated_at=now()
       WHERE id=$1 AND user_id=$2 AND ${OPEN}
         AND (claimed_at IS NULL OR claimed_at < now() - interval '${CLAIM_LEASE}')
       RETURNING id`,
      [draftId, userId]
    );
    return rows.length > 0;
  }

  async markApplied(userId: string, draftId: string, entityId: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE de_conversation_action_drafts
       SET status='applied', applied_entity_id=$3, updated_at=now()
       WHERE id=$1 AND user_id=$2 AND ${OPEN}`,
      [draftId, userId, entityId]
    );
  }
}

function toDraft(row: Record<string, unknown>): ConversationActionDraft {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
    featureScope: String(row.feature_scope),
    kind: String(row.kind),
    payload: (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>,
    preview: (row.preview && typeof row.preview === "object" ? row.preview : {}) as Record<string, unknown>,
    question: row.question ? String(row.question) : null,
    options: Array.isArray(row.options) ? row.options.filter((item): item is string => typeof item === "string") : [],
    status: String(row.status) as ConversationActionDraft["status"],
    appliedEntityId: row.applied_entity_id == null ? null : String(row.applied_entity_id),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    expiresAt: new Date(row.expires_at as string | Date).toISOString(),
  };
}
