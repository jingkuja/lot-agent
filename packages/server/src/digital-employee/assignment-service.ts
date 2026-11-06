import type { Pool } from "pg";
import { pickBackgroundTaskLlmModel } from "../models/catalog.js";
import type { AgentTurnContext } from "../services/agent-extensions.js";
import { attachmentKind, type AttachmentRef } from "../services/attachment-extractor.js";
import { AssignmentRepository, NODE_METADATA_KEY, type AssignmentCard, type AssignmentFilters } from "./assignment-repository.js";
import { isOpenStatus } from "./assignment-state.js";
import { assignmentTurn } from "./assignment-turn.js";
import type { AssignmentAttachmentInput } from "./assignment-validators.js";
import { ConflictError, InputError, NotFoundError } from "./errors.js";
import { digitalEmployeeAssignmentsEnabled } from "./feature-scope.js";
import { DIGITAL_EMPLOYEE_LLM_UNAVAILABLE } from "./llm.js";
import type { ProductImportService } from "./product-import-service.js";
import type { WorkLogService } from "./work-log-service.js";

/** The product's published rate. Spending is stored in yuan, like usage_logs; owners see credits. */
const CREDITS_PER_YUAN = 100;
const INITIAL_TITLE_CHARS = 30;

export interface AssignmentDeps {
  llmModels(userId: string): Promise<string[]>;
  imports: Pick<ProductImportService, "commitUnattended" | "itemsHeldFor">;
  workLog: Pick<WorkLogService, "conversation">;
}

export interface CreateAssignmentInput {
  goal: string;
  attachments: AssignmentAttachmentInput[];
  modelId: string | null;
  creditLimit: number | null;
}

export function isAssignmentConversation(metadata: unknown): boolean {
  return Boolean(metadata && typeof metadata === "object" && NODE_METADATA_KEY in metadata);
}

function initialTitle(goal: string, attachments: AttachmentRef[]): string {
  const line = goal.split("\n")[0]?.trim() || attachments[0]?.filename || "任务";
  return [...line].slice(0, INITIAL_TITLE_CHARS).join("");
}

const toYuan = (credits: number | null) => credits === null ? null : credits / CREDITS_PER_YUAN;

function view(card: AssignmentCard) {
  return {
    id: card.id, title: card.title, goal: card.goal, mode: card.mode, status: card.status,
    pausedReason: card.pausedReason, modelId: card.modelId, result: card.result, failureReason: card.failureReason,
    createdAt: card.createdAt, finishedAt: card.finishedAt,
    creditsUsed: Math.round(card.totalCost * CREDITS_PER_YUAN),
    creditLimit: card.costLimit === null ? null : Math.round(card.costLimit * CREDITS_PER_YUAN),
    subtasks: { done: card.subtasksDone, total: card.subtasksTotal },
    currentTool: card.currentTool,
    attachments: card.attachments.map((item) => item.filename),
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
      userId, modelId, attachments, costLimit: toYuan(input.creditLimit),
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
    return { ...view(card), runs };
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
    return assignmentTurn(node, input.base, input.toolNames, { repository: this.repository, imports: this.deps.imports });
  }
}
