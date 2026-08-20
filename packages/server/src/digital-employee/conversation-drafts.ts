import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { InputError, NotFoundError } from "./errors.js";

const TTL_MS = 24 * 60 * 60 * 1_000;

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
  status: "prepared" | "awaiting_confirmation" | "applied" | "expired";
  appliedEntityId: string | null;
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

/** Short-lived prepare/commit payloads for conversation write tools. */
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
        new Date(Date.now() + TTL_MS).toISOString(),
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

  async markApplied(userId: string, draftId: string, entityId: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE de_conversation_action_drafts
       SET status='applied', applied_entity_id=$3, updated_at=now()
       WHERE id=$1 AND user_id=$2 AND status IN ('prepared','awaiting_confirmation')`,
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
    expiresAt: new Date(row.expires_at as string | Date).toISOString(),
  };
}
