import type { Pool } from "pg";
import { pickBackgroundTaskLlmModel } from "../models/catalog.js";
import type { AgentTurnContext } from "../services/agent-extensions.js";
import { attachmentKind, type AttachmentRef } from "../services/attachment-extractor.js";
import { assignmentLink, replyAck, type ReplyOutcome } from "./assignment-notices.js";
import { isContinueReply, matchDecisionReply, quotedReply } from "./assignment-replies.js";
import {
  AssignmentRepository, NODE_METADATA_KEY, type AssignmentCard, type AssignmentDecision, type AssignmentFilters, type NewSubtask, type SubtaskCard,
} from "./assignment-repository.js";
import { isOpenStatus, type AssignmentMode, type DecisionAnswer } from "./assignment-state.js";
import { assignmentTurn } from "./assignment-turn.js";
import type { AssignmentAttachmentInput } from "./assignment-validators.js";
import { ConflictError, InputError, NotFoundError, UnverifiedOperationsError } from "./errors.js";
import { digitalEmployeeAssignmentsEnabled } from "./feature-scope.js";
import { DIGITAL_EMPLOYEE_LLM_UNAVAILABLE } from "./llm.js";
import type { ProductImportService } from "./product-import-service.js";
import type { WorkLogService } from "./work-log-service.js";

/** The product's published rate. Spending is stored in yuan, like usage_logs; owners see credits. */
const CREDITS_PER_YUAN = 100;
const INITIAL_TITLE_CHARS = 30;
const EVENT_PAGE = 20;
const BOARD_PAGE = 50;

export interface AssignmentDeps {
  llmModels(userId: string): Promise<string[]>;
  imports: Pick<ProductImportService, "commitUnattended" | "itemsHeldFor">;
  workLog: Pick<WorkLogService, "conversation" | "artifacts">;
}

export interface CreateAssignmentInput {
  goal: string;
  mode: AssignmentMode;
  attachments: AssignmentAttachmentInput[];
  modelId: string | null;
  creditLimit: number | null;
  /** Each one is a goal. Given here, they start at once and the employee does not plan. */
  subtasks?: string[];
  subtaskLimit?: number | null;
}

export function isAssignmentConversation(metadata: unknown): boolean {
  return Boolean(metadata && typeof metadata === "object" && NODE_METADATA_KEY in metadata);
}

function initialTitle(goal: string, attachments: AttachmentRef[]): string {
  const line = goal.split("\n")[0]?.trim() || attachments[0]?.filename || "任务";
  return [...line].slice(0, INITIAL_TITLE_CHARS).join("");
}

function subtaskFromGoal(goal: string): NewSubtask {
  return { goal, title: initialTitle(goal, []) };
}

const toYuan = (credits: number | null) => credits === null ? null : credits / CREDITS_PER_YUAN;

function view(card: AssignmentCard) {
  return {
    id: card.id, title: card.title, goal: card.goal, mode: card.mode, status: card.status,
    pausedReason: card.pausedReason, modelId: card.modelId, result: card.result, failureReason: card.failureReason,
    createdAt: card.createdAt, finishedAt: card.finishedAt,
    creditsUsed: Math.round(card.totalCost * CREDITS_PER_YUAN),
    creditLimit: card.costLimit === null ? null : Math.round(card.costLimit * CREDITS_PER_YUAN),
    subtasks: { done: card.subtasksDone, total: card.subtasksTotal, missed: card.subtasksMissed },
    subtaskLimit: card.subtaskLimit,
    currentTool: card.currentTool, waitingDecisions: card.waitingDecisions,
    attachments: card.attachments.map((item) => item.filename),
  };
}

function decisionView(decision: AssignmentDecision) {
  const { id, assignmentId, rootId, conversationId, title, kind, question, options, multiSelect, failureReason, unverified, createdAt } = decision;
  return { id, assignmentId, rootId, conversationId, title, kind, question, options, multiSelect, failureReason, unverified, createdAt };
}

function subtaskView(item: SubtaskCard) {
  return {
    id: item.id, position: item.position, title: item.title, goal: item.goal, status: item.status, failureReason: item.failureReason,
    result: item.result, summary: item.summary, createdBy: item.createdBy, retriesUsed: item.retriesUsed, unverified: item.unverified,
    conversationId: item.conversationId, finishedAt: item.finishedAt,
  };
}

/** What the API and the agent turn need. The worker's runner shares the repository. */
export class AssignmentService {
  readonly repository: AssignmentRepository;

  constructor(private readonly pool: Pool, private readonly deps: AssignmentDeps) {
    this.repository = new AssignmentRepository(pool);
  }

  private assertEnabled() {
    if (!digitalEmployeeAssignmentsEnabled()) throw new NotFoundError("任务分派未开启");
  }

  /** Client fields are never trusted: everything but the display name comes from the owner's own asset row. */
  private async ownedAttachments(userId: string, inputs: AssignmentAttachmentInput[]): Promise<AttachmentRef[]> {
    if (!inputs.length) return [];
    const { rows } = await this.pool.query(
      `SELECT id, mime, size_bytes, url FROM assets WHERE user_id=$1 AND id::text = ANY($2::text[])`,
      [userId, inputs.map((item) => item.assetId)]
    );
    const assets = new Map(rows.map((row) => [String(row.id), row]));
    return inputs.map((input) => {
      const asset = assets.get(input.assetId);
      if (!asset) throw new NotFoundError("附件不存在");
      return {
        assetId: input.assetId, filename: input.filename, mime: String(asset.mime), size: Number(asset.size_bytes),
        url: String(asset.url), kind: attachmentKind(String(asset.mime)),
      };
    });
  }

  private async chooseModel(userId: string, requested: string | null): Promise<string> {
    const models = await this.deps.llmModels(userId);
    if (requested && models.includes(requested)) return requested;
    const modelId = pickBackgroundTaskLlmModel(models);
    if (!modelId) throw new InputError(DIGITAL_EMPLOYEE_LLM_UNAVAILABLE);
    return modelId;
  }

  async create(userId: string, input: CreateAssignmentInput) {
    this.assertEnabled();
    const attachments = await this.ownedAttachments(userId, input.attachments);
    const modelId = await this.chooseModel(userId, input.modelId);
    const node = await this.repository.create({
      userId, modelId, attachments, costLimit: toYuan(input.creditLimit), mode: input.mode, subtaskLimit: input.subtaskLimit ?? null,
      subtasks: (input.subtasks ?? []).map(subtaskFromGoal),
      title: initialTitle(input.goal, attachments), goal: input.goal || attachments.map((item) => item.filename).join("、"),
    });
    return view(await this.repository.get(userId, node.id));
  }

  async list(userId: string, filters: AssignmentFilters) {
    this.assertEnabled();
    const page = await this.repository.list(userId, filters);
    return { items: page.items.map(view), pinned: page.pinned.map(view), nextCursor: page.nextCursor };
  }

  async get(userId: string, id: string) {
    this.assertEnabled();
    const card = await this.repository.get(userId, id);
    const work = await this.deps.workLog.conversation(userId, card.conversationId);
    const runs = work.runs.map(({ id: runId, status, startedAt, finishedAt, steps }) => ({ id: runId, status, startedAt, finishedAt, steps }));
    const [decisions, unverified, subtasks, board, conversations] = await Promise.all([
      this.repository.openDecisions(userId, id), this.repository.unverifiedOperations(card), this.repository.subtasks(userId, id),
      this.repository.boardPage(id, userId, { limit: BOARD_PAGE, includeSummaries: true }), this.repository.treeConversations(userId, id),
    ]);
    return {
      ...view(card), runs, conversationId: card.conversationId, unverified, decisions: decisions.map(decisionView),
      subtaskList: subtasks.map(subtaskView), board, artifacts: await this.deps.workLog.artifacts(userId, conversations),
    };
  }

  async board(userId: string, id: string, before?: string) {
    this.assertEnabled();
    await this.repository.get(userId, id);
    return { entries: await this.repository.boardPage(id, userId, { before, limit: BOARD_PAGE, includeSummaries: true }) };
  }

  /** How one subtask got where it is. Loaded when the owner opens it, since a task can have many. */
  async subtaskSteps(userId: string, id: string, subtaskId: string) {
    this.assertEnabled();
    const node = await this.repository.subtask(userId, id, subtaskId);
    const work = await this.deps.workLog.conversation(userId, node.conversationId);
    return { runs: work.runs.map(({ id: runId, status, startedAt, finishedAt, steps }) => ({ id: runId, status, startedAt, finishedAt, steps })) };
  }

  async addSubtask(userId: string, id: string, goal: string) {
    this.assertEnabled();
    await this.repository.addSubtasks(userId, id, [subtaskFromGoal(goal)], "owner", null);
    return view(await this.repository.get(userId, id));
  }

  async cancelSubtask(userId: string, id: string, subtaskId: string) {
    this.assertEnabled();
    await this.repository.subtask(userId, id, subtaskId);
    if (!await this.repository.cancelSubtask(userId, id, subtaskId)) throw new ConflictError("子任务已经结束");
    await this.repository.wakeTree(id);
    return view(await this.repository.get(userId, id));
  }

  /** The owner's own retry: it does not use up the team's. */
  async retrySubtask(userId: string, id: string, subtaskId: string) {
    this.assertEnabled();
    await this.repository.retrySubtask(userId, id, subtaskId);
    return view(await this.repository.get(userId, id));
  }

  async setSubtaskLimit(userId: string, id: string, limit: number | null) {
    this.assertEnabled();
    const card = await this.repository.get(userId, id);
    if (!isOpenStatus(card.status)) throw new ConflictError("任务已经结束");
    await this.repository.setSubtaskLimit(userId, id, limit);
    return view(await this.repository.get(userId, id));
  }

  async answer(userId: string, decisionId: string, answer: DecisionAnswer) {
    this.assertEnabled();
    const { rootId } = await this.repository.answerDecision(userId, decisionId, answer, "web");
    await this.repository.wakeTree(rootId);
    return view(await this.repository.get(userId, rootId));
  }

  /** Answers a decision or restarts a stopped task from a chat reply. Null leaves the message to the general assistant. */
  async routeReply(input: { userId: string; parentId?: string; text: string }, english: boolean): Promise<string | null> {
    if (!digitalEmployeeAssignmentsEnabled()) return null;
    const { userId, parentId, text } = input;
    const quoted = parentId ? await this.repository.decisionByFeishuMessage(userId, parentId) : null;
    if (quoted) return this.applyReply(userId, quoted, quotedReply(text, quoted), english);
    if (!parentId) {
      const open = await this.repository.openDecisions(userId);
      const matches = open.filter((decision) => matchDecisionReply(text, decision));
      if (open.length === 1 && matches[0]) return this.applyReply(userId, matches[0], matchDecisionReply(text, matches[0])!, english);
      // Which one it answers cannot be told, and guessing could approve the wrong thing.
      if (matches.length) return replyAck("quote_needed", "", english);
    }
    if (isContinueReply(text) && await this.repository.resumeQuotaPaused(userId)) return replyAck("continue", "", english);
    return null;
  }

  private async applyReply(userId: string, decision: AssignmentDecision, answer: DecisionAnswer, english: boolean): Promise<string> {
    const link = assignmentLink(decision.rootId);
    if (decision.answered) return replyAck("answered_already", link, english);
    let outcome: ReplyOutcome;
    try {
      outcome = (await this.repository.answerDecision(userId, decision.id, answer, "feishu")).applied;
      await this.repository.wakeTree(decision.rootId);
    } catch (error) {
      if (error instanceof UnverifiedOperationsError) outcome = "unverified";
      else if (error instanceof ConflictError) outcome = "answered_already";
      else throw error;
    }
    return replyAck(outcome, link, english);
  }

  /** What is stopped until the owner acts: questions and failures, then tasks stopped by quota or a cost limit. */
  async attention(userId: string) {
    if (!digitalEmployeeAssignmentsEnabled()) return [];
    const [decisions, paused] = await Promise.all([this.repository.openDecisions(userId), this.repository.pausedRoots(userId)]);
    return [
      ...decisions.map((decision) => ({
        rootId: decision.rootId, title: decision.title, createdAt: decision.createdAt, decision: decisionView(decision), pausedReason: null,
      })),
      ...paused.map((card) => ({
        rootId: card.id, title: card.title, createdAt: card.pausedAt ?? card.createdAt, decision: null, pausedReason: card.pausedReason,
      })),
    ];
  }

  /** Polled by the shell: open tasks set its pace, and the cursor gives each device its own desktop notifications. */
  async activity(userId: string, after?: string) {
    if (!digitalEmployeeAssignmentsEnabled()) return { open: 0, waiting: 0, events: [], cursor: null };
    const [counts, page] = await Promise.all([this.repository.activityCounts(userId), this.repository.eventsAfter(userId, after, EVENT_PAGE)]);
    return { ...counts, ...page };
  }

  async cancel(userId: string, id: string) {
    this.assertEnabled();
    await this.repository.get(userId, id);
    if (!await this.repository.cancel(userId, id)) throw new ConflictError("任务已经结束");
    return view(await this.repository.get(userId, id));
  }

  /** A task stopped at its cost limit needs room to go on; otherwise it would stop again at once. */
  async resume(userId: string, id: string, creditLimit?: number | null) {
    this.assertEnabled();
    const card = await this.repository.get(userId, id);
    if (!card.pausedReason) throw new ConflictError("任务没有暂停");
    if (creditLimit !== undefined) await this.repository.setCostLimit(userId, id, toYuan(creditLimit));
    const limit = creditLimit === undefined ? card.costLimit : toYuan(creditLimit);
    if (card.pausedReason === "cost_limit" && limit !== null && limit <= card.totalCost) throw new InputError("新的费用上限要高于已花费的积分");
    await this.repository.resume(userId, id, card.pausedReason);
    return view(await this.repository.get(userId, id));
  }

  /** The owner's own retry: it does not use up the automatic ones and keeps the earlier work. */
  async retry(userId: string, id: string) {
    this.assertEnabled();
    const card = await this.repository.get(userId, id);
    if (card.status !== "failed") throw new ConflictError("只有失败的任务可以重试");
    const unverified = await this.repository.unverifiedOperations(card);
    if (unverified) throw new UnverifiedOperationsError(unverified);
    await this.repository.retry(card);
    return view(await this.repository.get(userId, id));
  }

  async setCreditLimit(userId: string, id: string, creditLimit: number | null) {
    this.assertEnabled();
    const card = await this.repository.get(userId, id);
    if (!isOpenStatus(card.status)) throw new ConflictError("任务已经结束");
    await this.repository.setCostLimit(userId, id, toYuan(creditLimit));
    return view(await this.repository.get(userId, id));
  }

  /** Fails closed: without its node, a task conversation must not fall back to the chat rules. */
  async beginTurn(input: {
    userId: string | undefined; conversationId: string; toolNames: string[];
    base: Pick<AgentTurnContext, "dynamicParts" | "featureScope">;
  }): Promise<AgentTurnContext> {
    const node = input.userId ? await this.repository.findByConversation(input.conversationId, input.userId) : null;
    if (!node) throw new Error("Assignment conversation has no node");
    const root = node.id === node.rootId ? node : await this.repository.readNode(node.rootId);
    return assignmentTurn(node, root?.goal ?? "", input.base, input.toolNames, { repository: this.repository, imports: this.deps.imports });
  }
}
