import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AttachmentRef } from "../services/attachment-extractor.js";
import {
  FAILURE_CHOICES,
  OPEN_STATUSES,
  resumeMessage,
  transitionAssignment,
  type AssignmentMode,
  type AssignmentStatus,
  type DecisionAnswer,
  type EndIntent,
  type FailureChoice,
  type FailureReason,
  type OwnerQuestion,
  type PausedReason,
} from "./assignment-state.js";
import { ConflictError, InputError, NotFoundError, UnverifiedOperationsError } from "./errors.js";
import { DIGITAL_EMPLOYEE_UNIFIED_SCOPE } from "./feature-scope.js";

const AGENT_ID = "digital_employee";
/** Hidden from conversation lists, which show `active` only. */
const HIDDEN_STATUS = "hidden";
/** The title `generateTitle` replaces. */
const PLACEHOLDER_TITLE = "新对话";
const LEASE_SECONDS = 60;
const PINNED_LIMIT = 100;
const SWEEP_BATCH = 20;
export const NODE_METADATA_KEY = "digitalEmployeeAssignment";

export interface AssignmentResult {
  summary: string;
  assumptions: string[];
  skipped: string[];
}

export interface AssignmentNode {
  id: string;
  userId: string;
  rootId: string;
  title: string;
  goal: string;
  mode: AssignmentMode;
  status: AssignmentStatus;
  conversationId: string;
  modelId: string;
  result: AssignmentResult | null;
  failureReason: FailureReason | null;
  endIntent: EndIntent | null;
  autoResumed: boolean;
  /** The owner's answer, kept until the turn it starts has ended. */
  nextMessage: string | null;
  webSearches: number;
  tokensUsed: number;
  /** In yuan, like usage_logs. */
  costUsed: number;
  version: number;
  attachments: AttachmentRef[];
  pausedReason: PausedReason | null;
  pausedAt: string | null;
  costLimit: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AssignmentCard extends AssignmentNode {
  /** Models plus the posters and videos it ordered. */
  totalCost: number;
  subtasksDone: number;
  subtasksTotal: number;
  currentTool: string | null;
  waitingDecisions: number;
}

export type DecisionKind = "question" | "failure";

/** One per node at most, and several across a tree: nothing here assumes a single open decision. */
export interface AssignmentDecision {
  id: string;
  assignmentId: string;
  rootId: string;
  conversationId: string;
  /** The node's title, which is what the owner recognises. */
  title: string;
  kind: DecisionKind;
  question: string;
  options: string[];
  multiSelect: boolean;
  failureReason: FailureReason | null;
  unverified: number;
  answered: boolean;
  createdAt: string;
}

export interface NewDecision extends Partial<OwnerQuestion> {
  kind: DecisionKind;
  title: string;
  failureReason?: FailureReason;
  summary?: string;
}

export interface AssignmentFilters {
  from?: string;
  to?: string;
  q?: string;
  status?: "active" | "paused" | "succeeded" | "failed" | "cancelled";
  cursor?: string;
  limit: number;
  /** Open tasks older than this leave their day and come back in `pinned`. */
  openBefore?: string;
}

export interface AssignmentEvent {
  id: string;
  userId: string;
  rootId: string;
  kind: "finished" | "paused" | "decision" | "reminder";
  payload: Record<string, unknown>;
}

/** A desktop's view of an event: names and codes, no model text. */
export interface AssignmentActivity {
  id: string;
  rootId: string;
  kind: AssignmentEvent["kind"];
  title: string;
  status: string | null;
}

export interface NewAssignment {
  userId: string;
  title: string;
  goal: string;
  mode: AssignmentMode;
  modelId: string;
  attachments: AttachmentRef[];
  costLimit: number | null;
}

type Row = Record<string, any>;

const iso = (value: unknown): string => new Date(value as string).toISOString();
const optionalIso = (value: unknown): string | null => value ? iso(value) : null;

function toNode(row: Row): AssignmentNode {
  return {
    id: String(row.id), userId: String(row.user_id), rootId: String(row.root_id), title: String(row.title), goal: String(row.goal),
    mode: row.mode, status: row.status, conversationId: String(row.conversation_id), modelId: String(row.model_id),
    result: row.result ?? null, failureReason: row.failure_reason ?? null, endIntent: row.end_intent ?? null, autoResumed: row.auto_resumed === true,
    nextMessage: row.next_message ?? null, webSearches: Number(row.web_searches), tokensUsed: Number(row.tokens_used), costUsed: Number(row.cost_used),
    version: Number(row.version),
    attachments: row.attachments ?? [], pausedReason: row.paused_reason ?? null, pausedAt: optionalIso(row.paused_at),
    costLimit: row.cost_limit === null || row.cost_limit === undefined ? null : Number(row.cost_limit),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), finishedAt: optionalIso(row.finished_at),
  };
}

function toCard(row: Row): AssignmentCard {
  return {
    ...toNode(row), totalCost: Number(row.total_cost), subtasksDone: Number(row.subtasks_done), subtasksTotal: Number(row.subtasks_total),
    currentTool: row.current_tool ?? null, waitingDecisions: Number(row.waiting_decisions),
  };
}

function toDecision(row: Row): AssignmentDecision {
  return {
    id: String(row.decision_id), assignmentId: String(row.id), rootId: String(row.root_id), conversationId: String(row.conversation_id),
    title: String(row.title), kind: row.decision_kind, question: String(row.question), options: row.options ?? [], multiSelect: row.multi_select === true,
    failureReason: row.failure_reason ?? null, unverified: Number(row.unverified), answered: row.decision_answered_at !== null,
    createdAt: iso(row.decision_created_at),
  };
}

function encodeCursor(row: Row): string {
  return Buffer.from(JSON.stringify([row.cursor_at, row.id])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "string") ? value as [string, string] : null;
  } catch { return null; }
}

/** LIKE treats these as wildcards; an owner searching "50%" means the text. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Writes whose result nobody has confirmed. Only the owner can clear them, through the existing verify route. */
const UNVERIFIED = `(
  SELECT count(*) FROM agent_steps step JOIN agent_runs run ON run.id = step.run_id
  WHERE run.conversation_id = node.conversation_id AND run.user_id = node.user_id AND step.status = 'unknown_outcome'
)`;

const DECISION_COLUMNS = `decision.id AS decision_id, decision.kind AS decision_kind, decision.question, decision.options, decision.multi_select,
  decision.answered_at AS decision_answered_at, decision.created_at AS decision_created_at,
  node.id, node.root_id, node.conversation_id, node.title, node.failure_reason, ${UNVERIFIED} AS unverified`;

const DECISION_FROM = `de_assignment_decisions decision JOIN de_assignments node ON node.id = decision.assignment_id`;

const OPEN_LIST = `ARRAY[${OPEN_STATUSES.map((status) => `'${status}'`).join(",")}]`;

/** Everything the tree spent. Media tasks carry the conversation that ordered them. */
const TOTAL_COST = `(
  (SELECT COALESCE(SUM(node.cost_used), 0) FROM de_assignments node WHERE node.root_id = r.id)
  + (SELECT COALESCE(SUM(usage.total_cost), 0) FROM de_assignments node
     JOIN tasks task ON task.input ? 'sourceConversationId' AND task.input->>'sourceConversationId' = node.conversation_id::text
     JOIN usage_logs usage ON usage.task_id = task.id
     WHERE node.root_id = r.id AND usage.user_id = r.user_id)
)`;

const CARD_COLUMNS = `r.*, r.created_at::text AS cursor_at, ${TOTAL_COST} AS total_cost,
  (SELECT count(*) FROM de_assignments child WHERE child.root_id = r.id AND child.id <> r.id) AS subtasks_total,
  (SELECT count(*) FROM de_assignments child WHERE child.root_id = r.id AND child.id <> r.id
     AND child.status IN ('succeeded', 'skipped')) AS subtasks_done,
  (SELECT count(*) FROM de_assignment_decisions decision JOIN de_assignments node ON node.id = decision.assignment_id
     WHERE node.root_id = r.id AND decision.answered_at IS NULL) AS waiting_decisions,
  CASE WHEN r.status = 'running' THEN (
    SELECT step.tool_name FROM agent_steps step JOIN agent_runs run ON run.id = step.run_id
    WHERE run.conversation_id = r.conversation_id AND run.user_id = r.user_id
    ORDER BY step.started_at DESC LIMIT 1
  ) END AS current_tool`;

/** All SQL for task dispatch. Every read and write names the owner, and nothing here takes a model-supplied user id. */
export class AssignmentRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async create(input: NewAssignment): Promise<AssignmentNode> {
    const id = randomUUID();
    const conversationId = randomUUID();
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO conversations (id, title, model, agent_id, user_id, metadata, status) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          conversationId, PLACEHOLDER_TITLE, input.modelId, AGENT_ID, input.userId,
          JSON.stringify({ digitalEmployeeFeatureScope: DIGITAL_EMPLOYEE_UNIFIED_SCOPE, [NODE_METADATA_KEY]: id }), HIDDEN_STATUS,
        ]
      );
      const { rows } = await client.query(
        `INSERT INTO de_assignments (id, user_id, root_id, title, goal, mode, conversation_id, model_id, attachments, cost_limit)
         VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
        [id, input.userId, input.title, input.goal, input.mode, conversationId, input.modelId, JSON.stringify(input.attachments), input.costLimit]
      );
      return toNode(rows[0]);
    });
  }

  async get(userId: string, id: string): Promise<AssignmentCard> {
    const { rows } = await this.pool.query(`SELECT ${CARD_COLUMNS} FROM de_assignments r WHERE r.id=$1 AND r.user_id=$2 AND r.id=r.root_id`, [id, userId]);
    if (!rows[0]) throw new NotFoundError("任务不存在");
    return toCard(rows[0]);
  }

  /** Roots only; a subtask counts through its parent, including in the keyword match. */
  async list(userId: string, filters: AssignmentFilters): Promise<{ items: AssignmentCard[]; pinned: AssignmentCard[]; nextCursor: string | null }> {
    const params: unknown[] = [userId];
    const bind = (value: unknown) => `$${params.push(value)}`;
    const where = ["r.user_id=$1", "r.id=r.root_id"];
    if (filters.from) where.push(`r.created_at >= ${bind(filters.from)}::timestamptz`);
    if (filters.to) where.push(`r.created_at <= ${bind(filters.to)}::timestamptz`);
    if (filters.q) {
      const pattern = bind(likePattern(filters.q));
      where.push(`EXISTS (SELECT 1 FROM de_assignments node WHERE node.root_id=r.id AND (node.title ILIKE ${pattern} OR node.goal ILIKE ${pattern}))`);
    }
    if (filters.status === "active") where.push(`r.status = ANY(${OPEN_LIST}) AND r.paused_at IS NULL`);
    else if (filters.status === "paused") where.push(`r.status = ANY(${OPEN_LIST}) AND r.paused_at IS NOT NULL`);
    else if (filters.status === "cancelled") where.push(`r.status IN ('cancelled', 'skipped')`);
    else if (filters.status) where.push(`r.status = ${bind(filters.status)}`);
    if (filters.openBefore) where.push(`NOT (r.status = ANY(${OPEN_LIST}) AND r.created_at < ${bind(filters.openBefore)}::timestamptz)`);
    const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
    if (cursor) where.push(`(r.created_at, r.id) < (${bind(cursor[0])}::timestamptz, ${bind(cursor[1])}::uuid)`);
    const { rows } = await this.pool.query(
      `SELECT ${CARD_COLUMNS} FROM de_assignments r WHERE ${where.join(" AND ")}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ${bind(filters.limit + 1)}`,
      params
    );
    const page = rows.slice(0, filters.limit);
    const pinned = filters.openBefore && !cursor ? (await this.pool.query(
      `SELECT ${CARD_COLUMNS} FROM de_assignments r
       WHERE r.user_id=$1 AND r.id=r.root_id AND r.status = ANY(${OPEN_LIST}) AND r.created_at < $2::timestamptz
       ORDER BY r.created_at DESC LIMIT ${PINNED_LIMIT}`,
      [userId, filters.openBefore]
    )).rows : [];
    return {
      items: page.map(toCard), pinned: pinned.map(toCard),
      nextCursor: rows.length > filters.limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  /** The root and whatever is still open under it. Finished subtasks keep their result. */
  async cancel(userId: string, id: string): Promise<boolean> {
    return this.transaction((client) => this.cancelTree(client, userId, id));
  }

  /** Decisions close first, in the order answering takes its locks. They need no answer: there is nothing left to decide. */
  private async cancelTree(client: PoolClient, userId: string, rootId: string): Promise<boolean> {
    await client.query(
      `UPDATE de_assignment_decisions SET answered_at=now(), answered_via='cancelled'
       WHERE answered_at IS NULL AND user_id=$1 AND assignment_id IN (SELECT id FROM de_assignments WHERE root_id=$2 AND user_id=$1)
         AND EXISTS (SELECT 1 FROM de_assignments root WHERE root.id=$2 AND root.id=root.root_id AND root.user_id=$1)`,
      [userId, rootId]
    );
    const { rows } = await client.query(
      `UPDATE de_assignments SET status='cancelled', version=version+1, lease_until=NULL, not_before=NULL, next_message=NULL, finished_at=now(), updated_at=now()
       WHERE user_id=$1 AND root_id=$2 AND status = ANY(${OPEN_LIST})
         AND EXISTS (SELECT 1 FROM de_assignments root WHERE root.id=$2 AND root.id=root.root_id AND root.user_id=$1)
       RETURNING id`,
      [userId, rootId]
    );
    return rows.length > 0;
  }

  async setCostLimit(userId: string, id: string, costLimit: number | null): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE de_assignments SET cost_limit=$3, updated_at=now() WHERE id=$1 AND user_id=$2 AND id=root_id`, [id, userId, costLimit]
    );
    if (!rowCount) throw new NotFoundError("任务不存在");
  }

  /** Nothing else changes: the nodes were left queued and carry on where they stopped. */
  async resume(userId: string, id: string, reason: PausedReason): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE de_assignments SET paused_at=NULL, paused_reason=NULL, updated_at=now()
       WHERE id=$1 AND user_id=$2 AND id=root_id AND paused_reason=$3`,
      [id, userId, reason]
    );
    if (!rowCount) throw new ConflictError("任务状态已变化，请刷新后重试");
  }

  async retry(node: AssignmentNode): Promise<void> {
    const status = transitionAssignment(node.status, "queued");
    const { rowCount } = await this.pool.query(
      `UPDATE de_assignments SET status=$3, version=version+1, result=NULL, failure_reason=NULL, end_intent=NULL, finished_at=NULL, updated_at=now()
       WHERE id=$1 AND version=$2 AND status='failed'`,
      [node.id, node.version, status]
    );
    if (!rowCount) throw new ConflictError("任务状态已变化，请刷新后重试");
  }

  /** All of an account's tasks that a quota stopped: a "continue" from a channel names no task. */
  async resumeQuotaPaused(userId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE de_assignments SET paused_at=NULL, paused_reason=NULL, updated_at=now()
       WHERE user_id=$1 AND id=root_id AND paused_reason='quota' AND status = ANY(${OPEN_LIST})`,
      [userId]
    );
    return rowCount ?? 0;
  }

  /** Writes with no confirmed result. Running the node again before the owner clears them could repeat one. */
  async unverifiedOperations(node: Pick<AssignmentNode, "conversationId" | "userId">): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT ${UNVERIFIED} AS total FROM (SELECT $1::uuid AS conversation_id, $2::varchar AS user_id) node`, [node.conversationId, node.userId]
    );
    return Number(rows[0].total);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.pool.query(`UPDATE de_assignments SET title=$2, updated_at=now() WHERE id=$1`, [id, title]);
  }

  // ── Decisions ──

  async openDecisions(userId: string, rootId?: string): Promise<AssignmentDecision[]> {
    const { rows } = await this.pool.query(
      `SELECT ${DECISION_COLUMNS} FROM ${DECISION_FROM}
       WHERE decision.user_id=$1 AND decision.answered_at IS NULL AND ($2::uuid IS NULL OR node.root_id=$2)
       ORDER BY decision.created_at`,
      [userId, rootId ?? null]
    );
    return rows.map(toDecision);
  }

  /** Quoting a reminder counts the same as quoting the first notice. */
  async decisionByFeishuMessage(userId: string, messageId: string): Promise<AssignmentDecision | null> {
    const { rows } = await this.pool.query(
      `SELECT ${DECISION_COLUMNS} FROM ${DECISION_FROM}
       WHERE decision.user_id=$1 AND (decision.feishu_message_id=$2 OR decision.feishu_reminder_id=$2) LIMIT 1`,
      [userId, messageId]
    );
    return rows[0] ? toDecision(rows[0]) : null;
  }

  /**
   * The one place a decision is answered, whichever channel it comes from. The row lock and the answered
   * check make a second answer lose, and it changes nothing. Nothing is recorded if the answer is refused.
   */
  async answerDecision(userId: string, decisionId: string, answer: DecisionAnswer, via: "web" | "feishu"): Promise<{ rootId: string; applied: "continue" | "skip" | "end" }> {
    return this.transaction(async (client) => {
      const { rows: [decision] } = await client.query(
        `SELECT assignment_id, kind, answered_at FROM de_assignment_decisions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [decisionId, userId]
      );
      if (!decision) throw new NotFoundError("决定不存在");
      if (decision.answered_at) throw new ConflictError("这件事已经决定过了");
      const { rows: [row] } = await client.query(`SELECT * FROM de_assignments WHERE id=$1 AND user_id=$2 FOR UPDATE`, [decision.assignment_id, userId]);
      const node = toNode(row);
      if (node.status !== "waiting_user") throw new ConflictError("任务状态已变化，请刷新后重试");
      const clean = cleanAnswer(decision.kind, answer);
      const applied = clean.choice === "skip" ? "skip" : clean.choice === "end" ? "end" : "continue";
      if (applied === "continue") {
        const { rows: [{ total }] } = await client.query(
          `SELECT ${UNVERIFIED} AS total FROM de_assignments node WHERE node.id=$1`, [node.id]
        );
        if (Number(total) > 0) throw new UnverifiedOperationsError(Number(total));
      }
      await client.query(
        `UPDATE de_assignment_decisions SET answer=$2, answered_via=$3, answered_at=now() WHERE id=$1`,
        [decisionId, [clean.choice, clean.text].filter(Boolean).join(": "), via]
      );
      if (applied === "end") await this.cancelTree(client, userId, node.rootId);
      else if (applied === "skip") {
        await client.query(
          `UPDATE de_assignments SET status=$2, version=version+1, finished_at=now(), updated_at=now() WHERE id=$1`,
          [node.id, transitionAssignment(node.status, "skipped")]
        );
      } else {
        await client.query(
          `UPDATE de_assignments SET status=$2, version=version+1, next_message=$3, failure_reason=NULL, result=NULL, updated_at=now() WHERE id=$1`,
          [node.id, transitionAssignment(node.status, "queued"), resumeMessage(decision.kind, clean)]
        );
      }
      return { rootId: node.rootId, applied };
    });
  }

  /** Saving needs the owner's own reply. The runner's continuation is also a user message, so messages cannot prove it. */
  async ownerAnsweredSince(userId: string, conversationId: string, draftId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM de_conversation_action_drafts draft
       JOIN de_assignments node ON node.conversation_id=$2 AND node.user_id=draft.user_id
       JOIN de_assignment_decisions decision ON decision.assignment_id=node.id AND decision.kind='question'
         AND decision.answer IS NOT NULL AND decision.answered_at > draft.created_at
       WHERE draft.id=$3 AND draft.user_id=$1 LIMIT 1`,
      [userId, conversationId, draftId]
    );
    return rows.length > 0;
  }

  /** Runs once per decision: the row lock lets one worker in, and the next sees reminded_at. */
  async queueReminders(afterHours: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `WITH due AS (
         UPDATE de_assignment_decisions decision SET reminded_at=now() FROM de_assignments node
         WHERE node.id=decision.assignment_id AND decision.answered_at IS NULL AND decision.reminded_at IS NULL
           AND decision.created_at < now() - make_interval(hours => $1)
         RETURNING decision.id, decision.user_id, decision.kind, decision.question, decision.options, decision.multi_select,
           node.root_id, node.title, node.failure_reason
       )
       INSERT INTO de_assignment_events (user_id, root_id, kind, payload)
       SELECT user_id, root_id, 'reminder', jsonb_build_object('decisionId', id, 'decisionKind', kind, 'title', title, 'question', question,
         'options', options, 'multiSelect', multi_select, 'failureReason', failure_reason) FROM due`,
      [afterHours]
    );
    return rowCount ?? 0;
  }

  /** A notice that lost the race with an answer is not sent. */
  async decisionIsOpen(id: string): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT 1 FROM de_assignment_decisions WHERE id=$1 AND answered_at IS NULL`, [id]);
    return rows.length > 0;
  }

  async saveDecisionMessage(id: string, kind: "decision" | "reminder", messageId: string): Promise<void> {
    const column = kind === "decision" ? "feishu_message_id" : "feishu_reminder_id";
    await this.pool.query(`UPDATE de_assignment_decisions SET ${column}=$2 WHERE id=$1`, [id, messageId]);
  }

  private async insertDecision(client: PoolClient, node: Pick<AssignmentNode, "id" | "userId" | "rootId">, draft: NewDecision): Promise<void> {
    const { kind, title, question = "", multiSelect = false, failureReason, summary } = draft;
    const options = kind === "failure" ? [...FAILURE_CHOICES] as FailureChoice[] : draft.options ?? [];
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO de_assignment_decisions (assignment_id, user_id, kind, question, options, multi_select) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
      [node.id, node.userId, kind, question, JSON.stringify(options), multiSelect]
    );
    await client.query(
      `INSERT INTO de_assignment_events (user_id, root_id, kind, payload) VALUES ($1,$2,'decision',$3::jsonb)`,
      [node.userId, node.rootId, JSON.stringify({
        decisionId: id, decisionKind: kind, title, question, options, multiSelect, failureReason: failureReason ?? null, summary: summary ?? "",
      })]
    );
  }

  /** Quota and cost stops, which the owner also has to act on. */
  async pausedRoots(userId: string): Promise<AssignmentCard[]> {
    const { rows } = await this.pool.query(
      `SELECT ${CARD_COLUMNS} FROM de_assignments r
       WHERE r.user_id=$1 AND r.id=r.root_id AND r.paused_at IS NOT NULL AND r.status = ANY(${OPEN_LIST})
       ORDER BY r.paused_at DESC LIMIT ${PINNED_LIMIT}`,
      [userId]
    );
    return rows.map(toCard);
  }

  /** Set the polling pace, and the number on the sidebar. */
  async activityCounts(userId: string): Promise<{ open: number; waiting: number }> {
    const { rows: [row] } = await this.pool.query(
      `SELECT
         (SELECT count(*) FROM de_assignments r WHERE r.user_id=$1 AND r.id=r.root_id AND r.status = ANY(${OPEN_LIST})) AS open,
         (SELECT count(*) FROM de_assignment_decisions decision WHERE decision.user_id=$1 AND decision.answered_at IS NULL) +
         (SELECT count(*) FROM de_assignments r WHERE r.user_id=$1 AND r.id=r.root_id AND r.paused_at IS NOT NULL AND r.status = ANY(${OPEN_LIST})) AS waiting`,
      [userId]
    );
    return { open: Number(row.open), waiting: Number(row.waiting) };
  }

  /** Without a cursor nothing comes back: a new device starts from now instead of replaying history. */
  async eventsAfter(userId: string, after: string | undefined, limit: number): Promise<{ events: AssignmentActivity[]; cursor: string | null }> {
    if (after === undefined) {
      const { rows } = await this.pool.query(`SELECT max(id) AS last FROM de_assignment_events WHERE user_id=$1`, [userId]);
      return { events: [], cursor: rows[0].last === null ? "0" : String(rows[0].last) };
    }
    const { rows } = await this.pool.query(
      `SELECT id, root_id, kind, payload FROM de_assignment_events WHERE user_id=$1 AND id > $2::bigint ORDER BY id LIMIT $3`, [userId, after, limit]
    );
    return {
      events: rows.map((row) => ({
        id: String(row.id), rootId: String(row.root_id), kind: row.kind, title: String(row.payload.title ?? ""),
        status: typeof row.payload.status === "string" ? row.payload.status : null,
      })),
      cursor: rows.length ? String(rows[rows.length - 1].id) : after,
    };
  }

  // ── Runner ──

  /**
   * One node, so the per-account limit sees the row it just took. Two workers racing can pass the limit
   * by a node, which only matters to gateway rate limits and is not worth a lock.
   */
  async claim(userConcurrency: number): Promise<AssignmentNode | null> {
    const { rows } = await this.pool.query(
      `WITH next AS (
         SELECT node.id FROM de_assignments node JOIN de_assignments root ON root.id = node.root_id
         WHERE node.status='queued' AND root.paused_at IS NULL AND (node.not_before IS NULL OR node.not_before <= now())
           AND (SELECT count(*) FROM de_assignments busy WHERE busy.user_id=node.user_id AND busy.status='running') < $1
         ORDER BY node.created_at
         FOR UPDATE OF node SKIP LOCKED LIMIT 1
       )
       UPDATE de_assignments node SET status='running', version=version+1, end_intent=NULL, not_before=NULL,
         lease_until=now() + make_interval(secs => ${LEASE_SECONDS}), updated_at=now()
       FROM next WHERE node.id=next.id RETURNING node.*`,
      [userConcurrency]
    );
    return rows[0] ? toNode(rows[0]) : null;
  }

  /** False once the node stopped being ours: cancelled, or taken back after a lost lease. */
  async stillRunning(node: AssignmentNode): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT 1 FROM de_assignments WHERE id=$1 AND version=$2 AND status='running'`, [node.id, node.version]);
    return rows.length > 0;
  }

  async renewLease(node: AssignmentNode): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE de_assignments SET lease_until=now() + make_interval(secs => ${LEASE_SECONDS}) WHERE id=$1 AND version=$2 AND status='running'`,
      [node.id, node.version]
    );
    return (rowCount ?? 0) > 0;
  }

  /** Puts a node back without counting a turn, when its conversation is still held by a dying run. */
  async release(node: AssignmentNode, delayMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE de_assignments SET status='queued', version=version+1, lease_until=NULL, not_before=now() + make_interval(secs => $3), updated_at=now()
       WHERE id=$1 AND version=$2 AND status='running'`,
      [node.id, node.version, delayMs / 1000]
    );
  }

  async recordRun(node: AssignmentNode, runId: string): Promise<void> {
    await this.pool.query(`INSERT INTO de_assignment_runs (run_id, assignment_id, user_id) VALUES ($1,$2,$3)`, [runId, node.id, node.userId]);
  }

  async isFirstTurn(node: AssignmentNode): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT 1 FROM messages WHERE conversation_id=$1 AND role='user' LIMIT 1`, [node.conversationId]);
    return rows.length === 0;
  }

  async previousProgress(node: AssignmentNode, runId: string): Promise<boolean | null> {
    const { rows } = await this.pool.query(
      `SELECT made_progress FROM de_assignment_runs WHERE assignment_id=$1 AND run_id<>$2 ORDER BY created_at DESC LIMIT 1`, [node.id, runId]
    );
    return rows[0]?.made_progress ?? null;
  }

  async finishRun(runId: string, madeProgress: boolean): Promise<void> {
    await this.pool.query(`UPDATE de_assignment_runs SET made_progress=$2 WHERE run_id=$1`, [runId, madeProgress]);
  }

  /** Live figures for the cards, then what the limit is checked against. A pause set elsewhere stops this node too. */
  async checkpoint(node: AssignmentNode, usage: { tokens: number; cost: number }) {
    await this.pool.query(`UPDATE de_assignments SET tokens_used=$2, cost_used=$3 WHERE id=$1`, [node.id, node.tokensUsed + usage.tokens, node.costUsed + usage.cost]);
    const { rows } = await this.pool.query(
      `SELECT r.paused_at, r.cost_limit, CASE WHEN r.cost_limit IS NULL THEN 0 ELSE ${TOTAL_COST} END AS total_cost FROM de_assignments r WHERE r.id=$1`,
      [node.rootId]
    );
    const row = rows[0];
    return {
      paused: Boolean(row?.paused_at),
      overLimit: row?.cost_limit !== null && row?.cost_limit !== undefined && Number(row.total_cost) >= Number(row.cost_limit),
    };
  }

  /** The figures the run itself finished with, and the model it really used. */
  async syncUsage(node: AssignmentNode): Promise<void> {
    await this.pool.query(
      `UPDATE de_assignments node SET
         tokens_used = GREATEST(node.tokens_used, totals.tokens),
         cost_used = GREATEST(node.cost_used, totals.cost),
         model_id = COALESCE(conversation.model, node.model_id)
       FROM conversations conversation, LATERAL (
         SELECT COALESCE(SUM((run.state->>'totalTokens')::bigint), 0) AS tokens,
                COALESCE(SUM((run.state->>'totalCost')::numeric), 0) AS cost
         FROM agent_runs run WHERE run.conversation_id = conversation.id AND run.user_id = conversation.user_id
       ) totals
       WHERE node.id=$1 AND conversation.id=node.conversation_id`,
      [node.id]
    );
  }

  /** The tool records its intent; the runner reads it once the turn has really ended. */
  async recordEndIntent(conversationId: string, userId: string, intent: EndIntent): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE de_assignments SET end_intent=$3::jsonb WHERE conversation_id=$1 AND user_id=$2 AND status='running'`,
      [conversationId, userId, JSON.stringify(intent)]
    );
    return (rowCount ?? 0) > 0;
  }

  async findByConversation(conversationId: string, userId: string): Promise<AssignmentNode | null> {
    const { rows } = await this.pool.query(`SELECT * FROM de_assignments WHERE conversation_id=$1 AND user_id=$2`, [conversationId, userId]);
    return rows[0] ? toNode(rows[0]) : null;
  }

  async readNode(id: string): Promise<AssignmentNode | null> {
    const { rows } = await this.pool.query(`SELECT * FROM de_assignments WHERE id=$1`, [id]);
    return rows[0] ? toNode(rows[0]) : null;
  }

  /** Taken before the search runs, so parallel calls cannot pass the limit. Null means it is used up. */
  async reserveSearch(conversationId: string, userId: string, limit: number): Promise<number | null> {
    const { rows } = await this.pool.query(
      `UPDATE de_assignments SET web_searches=web_searches+1 WHERE conversation_id=$1 AND user_id=$2 AND web_searches < $3 RETURNING web_searches`,
      [conversationId, userId, limit]
    );
    return rows[0] ? Number(rows[0].web_searches) : null;
  }

  async returnSearch(conversationId: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE de_assignments SET web_searches=web_searches-1 WHERE conversation_id=$1 AND user_id=$2 AND web_searches > 0`, [conversationId, userId]
    );
  }

  /** Stops a task where it stands. Only the first call writes an event, so parallel nodes notify once. */
  async pause(rootId: string, reason: PausedReason): Promise<boolean> {
    const { rows } = await this.pool.query(
      `WITH paused AS (
         UPDATE de_assignments SET paused_at=now(), paused_reason=$2, updated_at=now()
         WHERE id=$1 AND paused_at IS NULL AND status = ANY(${OPEN_LIST}) RETURNING id, user_id, title
       ), event AS (
         INSERT INTO de_assignment_events (user_id, root_id, kind, payload)
         SELECT user_id, id, 'paused', jsonb_build_object('reason', $2::text, 'title', title) FROM paused
       )
       SELECT id FROM paused`,
      [rootId, reason]
    );
    return rows.length > 0;
  }

  /** Ends a turn. Only one writer wins, so a node the owner cancelled meanwhile stays cancelled. */
  async settle(node: AssignmentNode, to: AssignmentStatus, outcome: {
    result?: AssignmentResult; failureReason?: FailureReason; autoResumed?: boolean; event?: Record<string, unknown>; decision?: NewDecision;
  } = {}): Promise<boolean> {
    const status = transitionAssignment(node.status, to);
    const final = to === "succeeded" || to === "failed";
    return this.transaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE de_assignments SET status=$3, version=version+1, lease_until=NULL, end_intent=NULL, next_message=NULL, updated_at=now(),
           result=COALESCE($4::jsonb, result), failure_reason=COALESCE($5, failure_reason), auto_resumed=auto_resumed OR $6,
           finished_at=CASE WHEN $7 THEN now() ELSE finished_at END
         WHERE id=$1 AND version=$2 AND status='running'`,
        [
          node.id, node.version, status, outcome.result ? JSON.stringify(outcome.result) : null, outcome.failureReason ?? null,
          outcome.autoResumed === true, final,
        ]
      );
      if (!rowCount) return false;
      if (outcome.decision) await this.insertDecision(client, node, outcome.decision);
      if (outcome.event) {
        await client.query(
          `INSERT INTO de_assignment_events (user_id, root_id, kind, payload) VALUES ($1,$2,'finished',$3::jsonb)`,
          [node.userId, node.rootId, JSON.stringify(outcome.event)]
        );
      }
      return true;
    });
  }

  /**
   * Nodes whose worker died. A turn that may have written something is never run again on its own; the
   * rest continue, once per node. Stale runs close here because no later run may come to close them.
   */
  async sweepOrphans(): Promise<Array<{ node: AssignmentNode; resumed: boolean }>> {
    return this.transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM de_assignments WHERE status='running' AND lease_until < now() ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT $1`, [SWEEP_BATCH]
      );
      const swept: Array<{ node: AssignmentNode; resumed: boolean }> = [];
      for (const row of rows) {
        const node = toNode(row);
        const { rows: unverified } = await client.query(
          `SELECT 1 FROM agent_steps step JOIN agent_runs run ON run.id = step.run_id
           WHERE run.conversation_id=$1 AND run.user_id=$2 AND step.effect='write' AND step.status IN ('running', 'unknown_outcome') LIMIT 1`,
          [node.conversationId, node.userId]
        );
        await client.query(
          `UPDATE agent_steps SET status=CASE WHEN effect='write' THEN 'unknown_outcome' ELSE 'failed' END, finished_at=now()
           WHERE status='running' AND run_id IN (SELECT id FROM agent_runs WHERE conversation_id=$1 AND user_id=$2 AND status='running')`,
          [node.conversationId, node.userId]
        );
        await client.query(
          `UPDATE agent_runs SET status='unknown_outcome', finished_at=now() WHERE conversation_id=$1 AND user_id=$2 AND status='running'`,
          [node.conversationId, node.userId]
        );
        await client.query(`UPDATE conversations SET active_run_id=NULL, run_started_at=NULL WHERE id=$1`, [node.conversationId]);
        const resumed = unverified.length === 0 && !node.autoResumed;
        if (resumed) {
          await client.query(
            `UPDATE de_assignments SET status='queued', auto_resumed=true, version=version+1, lease_until=NULL, updated_at=now() WHERE id=$1`, [node.id]
          );
        } else if (node.mode === "responsive") {
          const reason: FailureReason = unverified.length ? "unknown_outcome" : "interrupted";
          await client.query(
            `UPDATE de_assignments SET status='waiting_user', failure_reason=$2, version=version+1, lease_until=NULL, updated_at=now() WHERE id=$1`,
            [node.id, reason]
          );
          await this.insertDecision(client, node, { kind: "failure", title: node.title, failureReason: reason });
        } else {
          const reason: FailureReason = unverified.length ? "unknown_outcome" : "interrupted";
          await client.query(
            `UPDATE de_assignments SET status='failed', failure_reason=$2, version=version+1, lease_until=NULL, finished_at=now(), updated_at=now() WHERE id=$1`,
            [node.id, reason]
          );
          await client.query(
            `INSERT INTO de_assignment_events (user_id, root_id, kind, payload) VALUES ($1,$2,'finished',$3::jsonb)`,
            [node.userId, node.rootId, JSON.stringify({ status: "failed", title: node.title, failureReason: reason })]
          );
        }
        swept.push({ node, resumed });
      }
      return swept;
    });
  }

  /**
   * Claimed before sending, and a failed send is not repeated: its outcome can be unknown, and the result
   * is still in the app. A pause waits a moment, so tasks stopping together are counted in one message.
   */
  async claimEvents(limit: number, pauseDelayMs: number): Promise<AssignmentEvent[]> {
    const { rows } = await this.pool.query(
      `UPDATE de_assignment_events SET feishu_claimed_at=now() WHERE id IN (
         SELECT id FROM de_assignment_events
         WHERE feishu_claimed_at IS NULL AND (kind <> 'paused' OR created_at < now() - make_interval(secs => $2))
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1
       ) RETURNING id, user_id, root_id, kind, payload`,
      [limit, pauseDelayMs / 1000]
    );
    return rows.map((row) => ({ id: String(row.id), userId: String(row.user_id), rootId: String(row.root_id), kind: row.kind, payload: row.payload }));
  }

  async quotaNoticeSentSince(userId: string, excludeIds: string[], hours: number): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM de_assignment_events
       WHERE user_id=$1 AND kind='paused' AND payload->>'reason'='quota' AND feishu_claimed_at > now() - make_interval(hours => $2)
         AND NOT id = ANY($3::bigint[]) LIMIT 1`,
      [userId, hours, excludeIds]
    );
    return rows.length > 0;
  }

  async countQuotaPaused(userId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT count(*) AS total FROM de_assignments WHERE user_id=$1 AND id=root_id AND paused_reason='quota' AND status = ANY(${OPEN_LIST})`, [userId]
    );
    return Number(rows[0].total);
  }
}

/** Turns whatever a channel sent into what the decision needs. A failure answered in words means "do it this way". */
function cleanAnswer(kind: DecisionKind, answer: DecisionAnswer): DecisionAnswer {
  const text = answer.text?.trim() || undefined;
  if (kind === "question") {
    if (!text) throw new InputError("写下你的回答");
    return { text };
  }
  const choice = answer.choice ?? (text ? "change" : undefined);
  if (!choice) throw new InputError("选一个做法");
  return choice === "change" ? { choice, text } : { choice };
}
