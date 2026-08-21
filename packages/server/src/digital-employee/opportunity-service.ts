import { createHash, randomUUID } from "node:crypto";
import type { JobQueue } from "@lot-agent/core";
import type { Pool, PoolClient } from "pg";
import type { DB } from "../db/database.js";
import { ConflictError, InputError, NotFoundError } from "./errors.js";
import { discoverByRules, type DiscoveryCandidate } from "./opportunity-rules.js";
import type { RuleOpportunity } from "./opportunity-rules.js";
import { ConversationActionDrafts } from "./conversation-drafts.js";
import type {
  ActionResultInput, ActionUpdateInput, FollowUpActionPrepareInput, ManualActionInput, OpportunityDecisionInput, OpportunityListFilters,
  OpportunityListItem, OpportunitySettings, OpportunitySummary, OutreachChannel, OutreachDraft, OutreachGenerateInput,
  TalkTrackContext, TalkTrackRequest,
} from "./opportunity-types.js";

export interface OpportunityAdvicePatch {
  dedupKey: string;
  title?: string;
  objective?: string;
  method?: string;
  reason?: string;
}

export interface OpportunityAdviceGenerator {
  enhance(input: {
    userId: string;
    taskId: string | null;
    opportunities: Array<Pick<RuleOpportunity, "dedupKey" | "type" | "title" | "objective" | "method" | "reason" | "evidence" | "priority">>;
  }): Promise<{ modelId: string; patches: OpportunityAdvicePatch[] }>;
}

export interface OpportunityTalkTrackGenerator {
  generate(input: {
    userId: string;
    context: TalkTrackContext;
    request: TalkTrackRequest;
  }): Promise<{ modelId: string; reply: string }>;
}

export class OpportunityService {
  private readonly pool: Pool;
  private readonly drafts: ConversationActionDrafts;

  constructor(
    db: DB,
    private readonly queue?: JobQueue,
    private readonly adviceGenerator?: OpportunityAdviceGenerator,
    private readonly talkTrackGenerator?: OpportunityTalkTrackGenerator
  ) {
    this.pool = db.pool;
    this.drafts = new ConversationActionDrafts(db.pool);
  }

  async list(userId: string, filters: OpportunityListFilters) {
    await this.closeStaleActions(userId);
    const rows = filters.view === "pending"
      ? await this.pendingRows(userId)
      : await this.actionRows(userId, filters.view);
    const items = rows.map(toItem).filter((item) => matches(item, filters));
    const [summary, profileCount, settings, lastRun] = await Promise.all([
      this.summary(userId), this.profileCount(userId), this.getSettings(userId), this.lastRun(userId),
    ]);
    return {
      items,
      total: items.length,
      summary,
      hasProfiles: profileCount > 0,
      lastDiscoveredAt: lastRun,
      settings,
    };
  }

  async requestDiscovery(userId: string): Promise<{ runId: string; taskId: string; reused: boolean }> {
    if (!this.queue) throw new InputError("商机发现任务队列暂不可用");
    const scanDate = dateKey(new Date());
    return this.startOrReuseDiscovery(userId, `manual:${scanDate}`, scanDate);
  }

  /** Worker entry point; discovery stays useful without a model. */
  async runDiscovery(userId: string, runId: string, progress?: (value: number, stage?: string) => Promise<void>) {
    const claimed = await this.pool.query(
      `UPDATE de_follow_up_suggestion_runs SET status = 'running', started_at = now(), error_code = NULL
       WHERE id = $1 AND user_id = $2 AND status IN ('pending','failed') RETURNING id, task_id`,
      [runId, userId]
    );
    if (!claimed.rows[0]) {
      const existing = await this.pool.query("SELECT status, created_suggestion_count FROM de_follow_up_suggestion_runs WHERE id = $1 AND user_id = $2", [runId, userId]);
      if (!existing.rows[0]) throw new NotFoundError("未找到商机发现任务");
      return { runId, status: existing.rows[0].status, created: Number(existing.rows[0].created_suggestion_count) };
    }
    try {
      await progress?.(10, "正在筛选客户画像");
      const candidates = await this.discoveryCandidates(userId);
      await this.pool.query("UPDATE de_follow_up_suggestion_runs SET candidate_count = $2 WHERE id = $1", [runId, candidates.length]);
      const rules = candidates.flatMap((candidate) => discoverByRules(candidate));
      let opportunities = rules;
      let modelId: string | null = null;
      let discoveryMethod: "rules" | "hybrid" = "rules";
      if (this.adviceGenerator && rules.length > 0) {
        try {
          await progress?.(45, "正在完善行动建议");
          // Bound model context and cost. Remaining deterministic suggestions
          // are still persisted unchanged, so a large account never blocks.
          const generated = await this.adviceGenerator.enhance({
            userId,
            taskId: claimed.rows[0].task_id ?? null,
            opportunities: rules.slice(0, 40).map(({ dedupKey, type, title, objective, method, reason, evidence, priority, profileId }) => {
              const customerName = candidates.find((candidate) => candidate.profileId === profileId)?.displayName;
              return {
                dedupKey, type, method, priority,
                title: redactModelText(title, customerName),
                objective: redactModelText(objective, customerName),
                reason: redactModelText(reason, customerName),
                evidence: evidence.map((item) => ({ ...item, fact: redactModelText(item.fact, customerName) })),
              };
            }),
          });
          opportunities = applyAdvicePatches(rules, generated.patches);
          modelId = generated.modelId;
          discoveryMethod = "hybrid";
        } catch (error) {
          console.warn(`[opportunity] model advice degraded to rules for user ${userId}:`, error);
        }
      }
      let created = 0;
      let skipped = 0;
      for (let index = 0; index < opportunities.length; index += 1) {
        const opportunity = opportunities[index];
          const result = await this.pool.query(
            `INSERT INTO de_follow_up_suggestions (
              id,user_id,profile_id,suggestion_run_id,title,objective,follow_up_method,suggested_at,priority,
              reason,confidence,dedup_key,status,opportunity_type,evidence,valid_until,readiness,risk_flags,product_key,product_name
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,'suggested',$12,$13::jsonb,$14,$15,$16::jsonb,$17,$18)
            ON CONFLICT (user_id, dedup_key) DO NOTHING`,
            [randomUUID(), userId, opportunity.profileId, runId, opportunity.title, opportunity.objective,
              opportunity.method, opportunity.suggestedAt, opportunity.priority, opportunity.reason,
              opportunity.dedupKey, opportunity.type, JSON.stringify(opportunity.evidence), opportunity.validUntil,
              opportunity.readiness, JSON.stringify(opportunity.risks), opportunity.productKey, opportunity.productName]
          );
          if ((result.rowCount ?? 0) > 0) created += 1; else skipped += 1;
        await progress?.(Math.min(95, 50 + Math.round(((index + 1) / Math.max(opportunities.length, 1)) * 45)), "正在校验并保存商机");
      }
      await this.pool.query(
        `UPDATE de_follow_up_suggestion_runs SET status = 'succeeded', created_suggestion_count = $2,
          skipped_suggestion_count = $3, model_id = $4, finished_at = now() WHERE id = $1`,
        [runId, created, skipped, modelId]
      );
      await progress?.(100, "商机发现完成");
      return { runId, status: "succeeded", candidates: candidates.length, created, skipped, discoveryMethod };
    } catch (error) {
      await this.pool.query(
        "UPDATE de_follow_up_suggestion_runs SET status = 'failed', error_code = 'discovery_failed', finished_at = now() WHERE id = $1",
        [runId]
      );
      throw error;
    }
  }

  async decide(userId: string, opportunityId: string, input: OpportunityDecisionInput) {
    return this.transaction(async (client) => {
      const found = await client.query(
        `SELECT suggestion.*, profile.display_name, profile.organization, profile.relationship_stage
         FROM de_follow_up_suggestions suggestion
         JOIN de_customer_profiles profile ON profile.id = suggestion.profile_id AND profile.user_id = suggestion.user_id
         WHERE suggestion.id = $1 AND suggestion.user_id = $2 AND profile.status = 'active'
         FOR UPDATE OF suggestion`,
        [opportunityId, userId]
      );
      const row = found.rows[0];
      if (!row) throw new NotFoundError("未找到该商机");
      if (row.status !== "suggested") throw new ConflictError("该商机已经处理");
      if (input.decision === "snooze") {
        await client.query(
          `UPDATE de_follow_up_suggestions SET snoozed_until = $3, decision_reason = $4, version = version + 1
           WHERE id = $1 AND user_id = $2`,
          [opportunityId, userId, input.snoozedUntil, input.reason ?? null]
        );
        return { opportunityId, status: "snoozed", snoozedUntil: input.snoozedUntil };
      }
      if (input.decision === "dismiss") {
        await client.query(
          `UPDATE de_follow_up_suggestions SET status = 'dismissed', decision_reason = $3, decided_at = now(), version = version + 1
           WHERE id = $1 AND user_id = $2`,
          [opportunityId, userId, input.reason]
        );
        return { opportunityId, status: "dismissed" };
      }
      const risks = array(row.risk_flags) as Array<{ blocking?: boolean }>;
      if (risks.some((risk) => risk.blocking)) throw new InputError("当前存在待处理风险，请先完成风险挽回行动");
      const actionId = randomUUID();
      const scheduledAt = input.scheduledAt ?? row.suggested_at;
      await client.query(
        `INSERT INTO de_follow_up_tasks (
          id,user_id,owner_user_id,profile_id,suggestion_id,source,title,objective,note,follow_up_method,
          priority,scheduled_at,status,result_criteria,product_key,product_name
        ) VALUES ($1,$2,$2,$3,$4,'ai_accepted',$5,$6,'',$7,$8,$9,'pending',$10,$11,$12)`,
        [actionId, userId, row.profile_id, opportunityId, row.title, input.objective ?? row.objective,
          input.followUpMethod ?? row.follow_up_method, row.priority, scheduledAt,
          input.resultCriteria ?? defaultResultCriteria(row.opportunity_type), row.product_key, row.product_name]
      );
      await client.query(
        `UPDATE de_follow_up_suggestions SET status = 'accepted', decided_at = now(), snoozed_until = NULL, version = version + 1
         WHERE id = $1 AND user_id = $2`, [opportunityId, userId]
      );
      await this.syncProfileCadence(client, userId, row.profile_id);
      return { opportunityId, status: "accepted", actionId };
    });
  }

  async createAction(userId: string, input: ManualActionInput): Promise<OpportunityListItem> {
    const actionId = await this.insertManualAction(userId, input, this.pool);
    return this.getAction(userId, actionId);
  }

  async insertManualAction(
    userId: string,
    input: ManualActionInput,
    client: Pool | PoolClient = this.pool
  ): Promise<string> {
    const profile = await client.query(
      "SELECT id FROM de_customer_profiles WHERE id = $1 AND user_id = $2 AND status = 'active'",
      [input.profileId, userId]
    );
    if (!profile.rows[0]) throw new NotFoundError("未找到该客户画像");
    const actionId = randomUUID();
    await client.query(
      `INSERT INTO de_follow_up_tasks (
         id,user_id,owner_user_id,profile_id,source,opportunity_type,title,objective,note,
         follow_up_method,priority,scheduled_at,status,result_criteria,product_key,product_name
       ) VALUES ($1,$2,$2,$3,'manual',$4,$5,$6,'',$7,$8,$9,'pending',$10,$11,$12)`,
      [actionId, userId, input.profileId, input.opportunityType, input.title, input.objective,
        input.followUpMethod ?? null, input.priority, input.scheduledAt,
        input.resultCriteria ?? null, input.productKey ?? null, input.productName ?? null]
    );
    await this.syncProfileCadence(client, userId, input.profileId);
    return actionId;
  }

  async getAction(userId: string, actionId: string): Promise<OpportunityListItem> {
    const rows = await this.actionRows(userId, undefined, actionId);
    if (!rows[0]) throw new NotFoundError("未找到该行动");
    return toItem(rows[0]);
  }

  async updateAction(userId: string, actionId: string, input: ActionUpdateInput) {
    let sql: string;
    let params: unknown[];
    if (input.operation === "reschedule") {
      sql = `UPDATE de_follow_up_tasks SET scheduled_at = $4, version = version + 1
             WHERE id = $1 AND user_id = $2 AND version = $3 AND status = 'pending' RETURNING *`;
      params = [actionId, userId, input.version, input.scheduledAt];
    } else if (input.operation === "cancel") {
      sql = `UPDATE de_follow_up_tasks SET status = 'cancelled', cancelled_at = now(), close_reason = $4, version = version + 1
             WHERE id = $1 AND user_id = $2 AND version = $3 AND status IN ('pending','awaiting_result') RETURNING *`;
      params = [actionId, userId, input.version, input.reason ?? "user_cancelled"];
    } else {
      sql = `UPDATE de_follow_up_tasks SET status = 'awaiting_result', executed_at = now(), version = version + 1
             WHERE id = $1 AND user_id = $2 AND version = $3 AND status = 'pending' RETURNING *`;
      params = [actionId, userId, input.version];
    }
    const result = await this.pool.query(sql, params);
    if (!result.rows[0]) {
      const exists = await this.pool.query("SELECT 1 FROM de_follow_up_tasks WHERE id = $1 AND user_id = $2", [actionId, userId]);
      if (!exists.rows[0]) throw new NotFoundError("未找到该行动");
      throw new ConflictError();
    }
    const row = result.rows[0];
    await this.syncProfileCadence(
      this.pool,
      userId,
      row.profile_id,
      input.operation === "execute" ? row.executed_at ?? new Date() : null
    );
    return this.getAction(userId, actionId);
  }

  async addResult(userId: string, actionId: string, input: ActionResultInput) {
    return this.transaction(async (client) => {
      const found = await client.query(
        "SELECT * FROM de_follow_up_tasks WHERE id = $1 AND user_id = $2 FOR UPDATE", [actionId, userId]
      );
      const task = found.rows[0];
      if (!task) throw new NotFoundError("未找到该行动");
      if (task.status !== "awaiting_result") throw new ConflictError("该行动当前不需要回填结果");
      const profileUpdate = input.confirmedRelationshipStage ? { relationshipStage: input.confirmedRelationshipStage } : {};
      const recordId = randomUUID();
      await client.query(
        `INSERT INTO de_follow_up_records (
          id,user_id,profile_id,task_id,occurred_at,follow_up_method,outcome,note,next_action,customer_quote,next_action_at,profile_update
        ) VALUES ($1,$2,$3,$4,COALESCE($5,now()),$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [recordId, userId, task.profile_id, actionId, task.executed_at, task.follow_up_method, input.outcome,
          input.note ?? "", input.nextAction ?? null, input.customerQuote ?? null, input.nextActionAt ?? null, JSON.stringify(profileUpdate)]
      );
      await client.query(
        `UPDATE de_follow_up_tasks SET status = 'completed', completed_at = now(), version = version + 1
         WHERE id = $1 AND user_id = $2`, [actionId, userId]
      );
      if (input.confirmedRelationshipStage) {
        await client.query(
          `UPDATE de_customer_profiles SET relationship_stage = $3, version = version + 1
           WHERE id = $1 AND user_id = $2`, [task.profile_id, userId, input.confirmedRelationshipStage]
        );
      }
      let nextActionId: string | null = null;
      if (input.nextAction && input.nextActionAt) {
        nextActionId = randomUUID();
        await client.query(
          `INSERT INTO de_follow_up_tasks (
             id,user_id,owner_user_id,profile_id,source,title,objective,note,follow_up_method,priority,scheduled_at,status,result_criteria,product_key,product_name
           ) VALUES ($1,$2,$2,$3,'manual',$4,$4,'',$5,$6,$7,'pending','获得有效下一步',$8,$9)`,
          [nextActionId, userId, task.profile_id, input.nextAction, task.follow_up_method, task.priority, input.nextActionAt, task.product_key, task.product_name]
        );
      }
      const occurredAt = task.executed_at ?? new Date();
      await this.recordFollowUpObservation(client, {
        userId,
        profileId: task.profile_id,
        recordId,
        taskId: actionId,
        occurredAt,
        method: task.follow_up_method,
        outcome: input.outcome,
        note: input.note ?? "",
        customerQuote: input.customerQuote ?? "",
        nextAction: input.nextAction ?? "",
        productKey: task.product_key,
        productName: task.product_name,
      });
      await this.syncProfileCadence(client, userId, task.profile_id, occurredAt);
      return { recordId, actionId, status: "completed", nextActionId };
    });
  }

  async getSettings(userId: string): Promise<OpportunitySettings> {
    const result = await this.pool.query("SELECT * FROM de_follow_up_automation_settings WHERE user_id = $1", [userId]);
    const row = result.rows[0];
    return row ? toSettings(row) : { enabled: false, timezone: "Asia/Shanghai", dailyRunTime: "09:00", nextRunAt: null, lastRunAt: null, version: 0 };
  }

  async generateTalkTrack(userId: string, itemId: string, request: TalkTrackRequest) {
    if (!this.talkTrackGenerator) throw new InputError("话术生成服务暂不可用");
    let rows = await this.actionRows(userId, undefined, itemId);
    if (rows.length === 0) {
      const pending = await this.pool.query(
        `${baseSelect()} WHERE suggestion.user_id = $1 AND suggestion.id = $2 LIMIT 1`,
        [userId, itemId]
      );
      rows = pending.rows;
    }
    if (rows.length === 0) throw new NotFoundError("未找到该客户经营事项");
    const item = toItem(rows[0]);
    const detail = await this.pool.query(
      `SELECT left(profile.summary, 2000) AS summary, profile.tags,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'productName', state.product_name, 'journeyStage', state.journey_stage,
            'sentiment', state.sentiment, 'satisfaction', state.satisfaction,
            'health', state.health, 'needs', state.needs, 'objections', state.objections,
            'currentIssues', state.current_issues
          ) ORDER BY state.updated_at DESC)
          FROM de_customer_product_states state
          WHERE state.user_id = profile.user_id AND state.profile_id = profile.id
        ), '[]'::jsonb) AS product_states,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('text', recent.raw_text, 'occurredAt', recent.occurred_at) ORDER BY recent.occurred_at DESC)
          FROM (
            SELECT left(observation.raw_text, 1500) AS raw_text, COALESCE(observation.occurred_at, observation.created_at) AS occurred_at
            FROM de_customer_observations observation
            WHERE observation.user_id = profile.user_id AND observation.profile_id = profile.id
            ORDER BY COALESCE(observation.occurred_at, observation.created_at) DESC LIMIT 8
          ) recent
        ), '[]'::jsonb) AS recent_facts
       FROM de_customer_profiles profile
       WHERE profile.id = $1 AND profile.user_id = $2 AND profile.status = 'active'`,
      [item.profileId, userId]
    );
    if (!detail.rows[0]) throw new NotFoundError("未找到该客户画像");
    const product = item.productName ? await this.pool.query(
      `SELECT name, positioning, core_values, verifiable_facts, common_objections,
        current_benefits, prohibited_expressions, case_materials
       FROM marketing_products
       WHERE user_id = $1 AND status = 'active' AND lower(name) = lower($2)
       ORDER BY updated_at DESC LIMIT 1`,
      [userId, item.productName]
    ) : { rows: [] };
    const context: TalkTrackContext = {
      customerName: item.customerName,
      organization: item.organization,
      relationshipStage: item.relationshipStage,
      customerSummary: detail.rows[0].summary ?? "",
      tags: array(detail.rows[0].tags),
      opportunityType: item.opportunityType,
      title: item.title,
      objective: item.objective,
      reason: item.reason,
      followUpMethod: item.followUpMethod,
      productName: item.productName,
      resultCriteria: item.resultCriteria,
      customerProductStates: array(detail.rows[0].product_states),
      recentFacts: array(detail.rows[0].recent_facts).map((fact: any) => ({
        text: String(fact.text ?? ""),
        occurredAt: iso(fact.occurredAt ?? fact.occurred_at),
      })).filter((fact: { text: string }) => fact.text),
      productMaterial: product.rows[0] ?? null,
    };
    const generated = await this.talkTrackGenerator.generate({ userId, context, request });
    const reply = generated.reply.trim();
    if (!reply) throw new InputError("话术生成结果为空，请重试");
    return { reply, modelId: generated.modelId };
  }

  async getCustomerBusinessContext(userId: string, profileId: string) {
    await this.closeStaleActions(userId);
    const profile = await this.requireProfile(userId, profileId);
    const [detail, pending, actions, outreach] = await Promise.all([
      this.talkTrackFacts(userId, profileId),
      this.pendingRows(userId, profileId),
      this.actionRows(userId, undefined, undefined, profileId),
      this.pool.query(
        `SELECT id, channel, objective, content, version, used_at, created_at
         FROM de_outreach_drafts WHERE user_id=$1 AND profile_id=$2
         ORDER BY created_at DESC LIMIT 5`,
        [userId, profileId]
      ),
    ]);
    return {
      profile: {
        id: profile.id,
        displayName: profile.display_name,
        organization: profile.organization,
        relationshipStage: profile.relationship_stage,
        customerRegion: profile.customer_region,
        summary: detail.summary,
        tags: detail.tags,
        lastContactAt: iso(profile.last_contact_at),
        nextFollowUpAt: iso(profile.next_follow_up_at),
      },
      productStates: detail.productStates,
      recentFacts: detail.recentFacts,
      opportunities: pending.map(toItem),
      actions: actions.map(toItem),
      outreach: outreach.rows.map((row) => ({
        id: row.id, channel: row.channel, objective: row.objective, version: Number(row.version),
        usedAt: iso(row.used_at), createdAt: iso(row.created_at), excerpt: String(row.content ?? "").slice(0, 180),
      })),
      managementUrl: "/digital-employee/acquisition",
    };
  }

  async prepareFollowUpAction(
    userId: string,
    input: FollowUpActionPrepareInput,
    source: { conversationId?: string; sourceMessageId?: string }
  ) {
    const preview = await this.previewFollowUpAction(userId, input);
    return this.drafts.create({
      userId,
      conversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      featureScope: "opportunity-advisor",
      kind: "follow_up_action",
      payload: { ...input, version: preview.version ?? input.version },
      preview,
      question: String(preview.question),
      options: preview.options as string[],
    });
  }

  async commitFollowUpAction(userId: string, draftId: string, profileId?: string) {
    const draft = await this.drafts.get(userId, draftId, "follow_up_action");
    if (draft.status === "applied") {
      return { alreadyApplied: true, entityId: draft.appliedEntityId, preview: draft.preview, managementUrl: "/digital-employee/acquisition" };
    }
    const input = {
      ...(draft.payload as unknown as FollowUpActionPrepareInput),
      ...(profileId ? { profileId } : {}),
    };
    const result = await this.applyFollowUpAction(userId, input);
    const entityId = ("actionId" in result && result.actionId) || result.opportunityId || null;
    await this.drafts.markApplied(userId, draftId, entityId);
    return { ...result, alreadyApplied: false, managementUrl: "/digital-employee/acquisition" };
  }

  async prepareFollowUpResult(
    userId: string,
    actionId: string,
    input: ActionResultInput,
    source: { conversationId?: string; sourceMessageId?: string }
  ) {
    const action = await this.getAction(userId, actionId);
    if (action.status !== "awaiting_result") throw new ConflictError("该行动当前不需要回填结果");
    const preview = {
      customerName: action.customerName,
      profileId: action.profileId,
      actionId,
      title: action.title,
      outcome: input.outcome,
      nextAction: input.nextAction ?? null,
      nextActionAt: input.nextActionAt ?? null,
      confirmedRelationshipStage: input.confirmedRelationshipStage ?? null,
      question: `确认把「${action.customerName}」的「${action.title}」标记为${resultLabel(input.outcome)}？`,
      options: ["确认回填", "取消"],
    };
    return this.drafts.create({
      userId,
      conversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      featureScope: "opportunity-advisor",
      kind: "follow_up_result",
      payload: { actionId, ...input },
      preview,
      question: preview.question,
      options: preview.options,
    });
  }

  async commitFollowUpResult(userId: string, draftId: string) {
    const draft = await this.drafts.get(userId, draftId, "follow_up_result");
    if (draft.status === "applied") {
      return { alreadyApplied: true, entityId: draft.appliedEntityId, preview: draft.preview, managementUrl: "/digital-employee/acquisition" };
    }
    const payload = draft.payload as unknown as ActionResultInput & { actionId: string };
    const result = await this.addResult(userId, payload.actionId, payload);
    await this.drafts.markApplied(userId, draftId, result.recordId);
    return { ...result, alreadyApplied: false, managementUrl: "/digital-employee/acquisition" };
  }

  async generateOutreach(userId: string, input: OutreachGenerateInput): Promise<OutreachDraft> {
    const request: TalkTrackRequest = {
      intent: input.intent,
      message: channelPrompt(input.channel ?? "wechat", input.message),
      history: input.history ?? [],
    };
    let generated: { reply: string; modelId: string; objective: string; customerName: string };
    let profileId: string;
    let taskId: string | null = null;
    let opportunityId: string | null = null;
    if (input.itemId) {
      const item = await this.loadWorkItem(userId, input.itemId);
      const result = await this.generateTalkTrack(userId, input.itemId, request);
      generated = { ...result, objective: item.objective, customerName: item.customerName };
      profileId = item.profileId;
      taskId = item.actionId;
      opportunityId = item.opportunityId;
    } else {
      const result = await this.generateProfileTalkTrack(userId, input.profileId!, request);
      generated = { reply: result.reply, modelId: result.modelId, objective: result.context.objective, customerName: result.context.customerName };
      profileId = input.profileId!;
    }
    return this.saveOutreach({
      userId, profileId, taskId, opportunityId,
      channel: input.channel ?? "wechat",
      objective: generated.objective || input.message,
      content: generated.reply,
      source: "generated",
      modelId: generated.modelId,
      snapshot: { intent: input.intent, customerName: generated.customerName },
    });
  }

  async rewriteOutreach(userId: string, draftId: string, instruction: string): Promise<OutreachDraft> {
    const current = await this.getOutreach(userId, draftId);
    const generated = await this.generateProfileTalkTrack(userId, current.profileId, {
      intent: "follow_up",
      message: instruction,
      history: [
        { role: "assistant", content: current.content },
        { role: "user", content: instruction },
      ],
    });
    return this.saveOutreach({
      userId, profileId: current.profileId, taskId: current.taskId, opportunityId: current.opportunityId,
      parentId: current.id, channel: current.channel, objective: current.objective,
      content: generated.reply, source: "rewrite", version: current.version + 1, modelId: generated.modelId,
      snapshot: { rewriteOf: current.id },
    });
  }

  async markOutreachUsed(userId: string, draftId: string) {
    const { rows } = await this.pool.query(
      `UPDATE de_outreach_drafts SET used_at=now()
       WHERE id=$1 AND user_id=$2 AND used_at IS NULL RETURNING *`,
      [draftId, userId]
    );
    if (!rows[0]) {
      const existing = await this.getOutreach(userId, draftId);
      if (existing.usedAt) return existing;
      throw new NotFoundError("未找到该话术");
    }
    return toOutreach(rows[0]);
  }

  async saveSettings(userId: string, input: { enabled: boolean; timezone: string; dailyRunTime: string; version: number }) {
    const result = await this.pool.query(
      `INSERT INTO de_follow_up_automation_settings (user_id,enabled,timezone,daily_run_time,next_run_at,version)
       VALUES ($1,$2::boolean,$3::text,$4::time,
         CASE WHEN $2::boolean THEN next_daily_run($3::text,$4::time) ELSE NULL END,1)
       ON CONFLICT (user_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, timezone = EXCLUDED.timezone, daily_run_time = EXCLUDED.daily_run_time,
         next_run_at = CASE WHEN EXCLUDED.enabled THEN next_daily_run(EXCLUDED.timezone,EXCLUDED.daily_run_time) ELSE NULL END,
         version = de_follow_up_automation_settings.version + 1
       WHERE de_follow_up_automation_settings.version = $5
       RETURNING *`,
      [userId, input.enabled, input.timezone, input.dailyRunTime, input.version]
    );
    if (!result.rows[0]) throw new ConflictError();
    return toSettings(result.rows[0]);
  }

  async enqueueDueDiscoveries(now = new Date()): Promise<number> {
    if (!this.queue) return 0;
    const due = await this.pool.query(
      `SELECT user_id, timezone FROM de_follow_up_automation_settings
       WHERE enabled = true AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT 100`, [now]
    );
    let count = 0;
    for (const row of due.rows) {
      const scanDate = dateKey(now);
      try {
        const result = await this.startOrReuseDiscovery(row.user_id, `daily:${scanDate}`, scanDate);
        await this.advanceDiscoverySchedule(row.user_id, now);
        if (!result.reused) count += 1;
      } catch {
        // Enqueue failure leaves next_run_at in place so the next tick can retry.
      }
    }
    return count;
  }

  private async startOrReuseDiscovery(userId: string, idempotencyKey: string, scanDate: string): Promise<{ runId: string; taskId: string; reused: boolean }> {
    if (!this.queue) throw new InputError("商机发现任务队列暂不可用");
    const runId = randomUUID();
    const inserted = await this.pool.query(
      `INSERT INTO de_follow_up_suggestion_runs
        (id, user_id, idempotency_key, scan_date, prompt_version, status)
       VALUES ($1,$2,$3,$4,'opportunity-rules/v1','pending')
       ON CONFLICT DO NOTHING RETURNING id`,
      [runId, userId, idempotencyKey, scanDate]
    );
    if (inserted.rows[0]) {
      try {
        const taskId = await this.enqueueDiscovery(userId, inserted.rows[0].id);
        return { runId: inserted.rows[0].id, taskId, reused: false };
      } catch (error) {
        await this.markDiscoveryEnqueueFailed(inserted.rows[0].id);
        throw error;
      }
    }
    const existing = await this.pool.query(
      `SELECT id, task_id, status FROM de_follow_up_suggestion_runs
       WHERE user_id = $1 AND (idempotency_key = $2 OR scan_date = $3::date)
       ORDER BY created_at DESC LIMIT 1`,
      [userId, idempotencyKey, scanDate]
    );
    const row = existing.rows[0] as { id: string; task_id: string | null; status: string } | undefined;
    if (row?.task_id && row.status !== "failed") {
      return { runId: row.id, taskId: row.task_id, reused: true };
    }
    if (row && (row.status === "failed" || !row.task_id)) {
      try {
        const taskId = await this.enqueueDiscovery(userId, row.id);
        return { runId: row.id, taskId, reused: false };
      } catch (error) {
        await this.markDiscoveryEnqueueFailed(row.id);
        throw error;
      }
    }
    throw new ConflictError("今天的商机发现任务正在创建，请稍后重试");
  }

  private async enqueueDiscovery(userId: string, runId: string): Promise<string> {
    const taskId = await this.queue!.enqueue("opportunity.discover", { runId }, userId, { maxAttempts: 2 });
    await this.pool.query(
      `UPDATE de_follow_up_suggestion_runs
          SET task_id = $2, status = 'pending', error_code = NULL, finished_at = NULL
        WHERE id = $1 AND user_id = $3`,
      [runId, taskId, userId]
    );
    return taskId;
  }

  private async markDiscoveryEnqueueFailed(runId: string) {
    await this.pool.query(
      "UPDATE de_follow_up_suggestion_runs SET status = 'failed', error_code = 'enqueue_failed', finished_at = now() WHERE id = $1",
      [runId]
    );
  }

  private async advanceDiscoverySchedule(userId: string, now: Date) {
    await this.pool.query(
      `UPDATE de_follow_up_automation_settings SET last_run_at = $2::timestamptz,
        next_run_at = next_daily_run(timezone::text, daily_run_time, $2::timestamptz + interval '1 minute'),
        version = version + 1
       WHERE user_id = $1`, [userId, now]
    );
  }

  private async previewFollowUpAction(userId: string, input: FollowUpActionPrepareInput) {
    if (input.operation === "create") {
      const profile = await this.requireProfile(userId, input.profileId!);
      return {
        operation: input.operation, profileId: profile.id, customerName: profile.display_name,
        title: input.title, objective: input.objective, scheduledAt: input.scheduledAt,
        opportunityType: input.opportunityType, followUpMethod: input.followUpMethod ?? null,
        question: `确认为「${profile.display_name}」创建跟进「${input.title}」？`,
        options: ["确认创建", "取消"],
      };
    }
    if (input.operation === "accept" || input.operation === "snooze" || input.operation === "dismiss") {
      const item = await this.getOpportunity(userId, input.opportunityId!);
      const verb = input.operation === "accept" ? "采纳并创建行动" : input.operation === "snooze" ? "稍后处理" : "忽略";
      return {
        operation: input.operation, opportunityId: item.opportunityId, profileId: item.profileId,
        customerName: item.customerName, title: item.title, scheduledAt: input.scheduledAt ?? item.scheduledAt,
        snoozedUntil: input.snoozedUntil ?? null, reason: input.reason ?? null,
        question: `确认${verb}「${item.customerName}」的商机「${item.title}」？`,
        options: [`确认${verb}`, "取消"],
      };
    }
    const action = await this.getAction(userId, input.actionId!);
    const verb = input.operation === "reschedule" ? "改期" : input.operation === "cancel" ? "取消" : "标记已执行";
    return {
      operation: input.operation, actionId: action.actionId, profileId: action.profileId,
      customerName: action.customerName, title: action.title, scheduledAt: input.scheduledAt ?? action.scheduledAt,
      version: action.actionVersion, reason: input.reason ?? null,
      question: `确认${verb}「${action.customerName}」的行动「${action.title}」？`,
      options: [`确认${verb}`, "取消"],
    };
  }

  private async applyFollowUpAction(userId: string, input: FollowUpActionPrepareInput) {
    if (input.operation === "create") {
      const action = await this.createAction(userId, {
        profileId: input.profileId!,
        opportunityType: input.opportunityType!,
        title: input.title!,
        objective: input.objective!,
        followUpMethod: input.followUpMethod,
        priority: input.priority ?? "normal",
        scheduledAt: input.scheduledAt!,
        resultCriteria: input.resultCriteria,
        productName: input.productName,
      });
      return { opportunityId: action.opportunityId, actionId: action.actionId, status: action.status, action };
    }
    if (input.operation === "accept" || input.operation === "snooze" || input.operation === "dismiss") {
      return this.decide(userId, input.opportunityId!, {
        decision: input.operation === "accept" ? "accept" : input.operation === "snooze" ? "snooze" : "dismiss",
        reason: input.reason,
        snoozedUntil: input.snoozedUntil,
        scheduledAt: input.scheduledAt,
        followUpMethod: input.followUpMethod,
        objective: input.objective,
        resultCriteria: input.resultCriteria,
      });
    }
    const action = await this.updateAction(userId, input.actionId!, {
      operation: input.operation,
      scheduledAt: input.scheduledAt,
      reason: input.reason,
      version: input.version ?? 0,
    });
    return { opportunityId: action.opportunityId, actionId: action.actionId, status: action.status, action };
  }

  async getOpportunity(userId: string, opportunityId: string): Promise<OpportunityListItem> {
    const { rows } = await this.pool.query(
      `${baseSelect()} WHERE suggestion.user_id = $1 AND suggestion.id = $2 AND profile.status = 'active' LIMIT 1`,
      [userId, opportunityId]
    );
    if (!rows[0]) throw new NotFoundError("未找到该商机");
    return toItem(rows[0]);
  }

  private async requireProfile(userId: string, profileId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, display_name, organization, relationship_stage, customer_region, summary, tags,
              last_contact_at, next_follow_up_at
       FROM de_customer_profiles WHERE id=$1 AND user_id=$2 AND status='active'`,
      [profileId, userId]
    );
    if (!rows[0]) throw new NotFoundError("未找到该客户画像");
    return rows[0];
  }

  private async talkTrackFacts(userId: string, profileId: string) {
    const detail = await this.pool.query(
      `SELECT left(profile.summary, 2000) AS summary, profile.tags,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'productName', state.product_name, 'journeyStage', state.journey_stage,
            'sentiment', state.sentiment, 'satisfaction', state.satisfaction,
            'health', state.health, 'needs', state.needs, 'objections', state.objections,
            'currentIssues', state.current_issues
          ) ORDER BY state.updated_at DESC)
          FROM de_customer_product_states state
          WHERE state.user_id = profile.user_id AND state.profile_id = profile.id
        ), '[]'::jsonb) AS product_states,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('text', recent.raw_text, 'occurredAt', recent.occurred_at) ORDER BY recent.occurred_at DESC)
          FROM (
            SELECT left(observation.raw_text, 1500) AS raw_text, COALESCE(observation.occurred_at, observation.created_at) AS occurred_at
            FROM de_customer_observations observation
            WHERE observation.user_id = profile.user_id AND observation.profile_id = profile.id
            ORDER BY COALESCE(observation.occurred_at, observation.created_at) DESC LIMIT 8
          ) recent
        ), '[]'::jsonb) AS recent_facts
       FROM de_customer_profiles profile
       WHERE profile.id = $1 AND profile.user_id = $2 AND profile.status = 'active'`,
      [profileId, userId]
    );
    if (!detail.rows[0]) throw new NotFoundError("未找到该客户画像");
    return {
      summary: detail.rows[0].summary ?? "",
      tags: array(detail.rows[0].tags),
      productStates: array(detail.rows[0].product_states),
      recentFacts: array(detail.rows[0].recent_facts).map((fact: any) => ({
        text: String(fact.text ?? ""),
        occurredAt: iso(fact.occurredAt ?? fact.occurred_at),
      })).filter((fact: { text: string }) => fact.text),
    };
  }

  private async loadWorkItem(userId: string, itemId: string): Promise<OpportunityListItem & { actionVersion?: number }> {
    const actions = await this.actionRows(userId, undefined, itemId);
    if (actions[0]) return toItem(actions[0]);
    const pending = await this.pool.query(
      `${baseSelect()} WHERE suggestion.user_id = $1 AND suggestion.id = $2 LIMIT 1`,
      [userId, itemId]
    );
    if (!pending.rows[0]) throw new NotFoundError("未找到该客户经营事项");
    return toItem(pending.rows[0]);
  }

  private async generateProfileTalkTrack(userId: string, profileId: string, request: TalkTrackRequest) {
    if (!this.talkTrackGenerator) throw new InputError("话术生成服务暂不可用");
    const profile = await this.requireProfile(userId, profileId);
    const facts = await this.talkTrackFacts(userId, profileId);
    const productName = facts.productStates[0]?.productName ?? null;
    const product = productName ? await this.pool.query(
      `SELECT name, positioning, core_values, verifiable_facts, common_objections,
        current_benefits, prohibited_expressions, case_materials
       FROM marketing_products
       WHERE user_id = $1 AND status = 'active' AND lower(name) = lower($2)
       ORDER BY updated_at DESC LIMIT 1`,
      [userId, productName]
    ) : { rows: [] };
    const context: TalkTrackContext = {
      customerName: profile.display_name,
      organization: profile.organization ?? null,
      relationshipStage: profile.relationship_stage,
      customerSummary: facts.summary,
      tags: facts.tags,
      opportunityType: profile.relationship_stage === "customer" ? "repurchase" : "prospect_progress",
      title: "个性化联系",
      objective: request.message,
      reason: facts.summary || "用户主动要求生成联系话术",
      followUpMethod: null,
      productName,
      resultCriteria: null,
      customerProductStates: facts.productStates,
      recentFacts: facts.recentFacts,
      productMaterial: product.rows[0] ?? null,
    };
    const generated = await this.talkTrackGenerator.generate({ userId, context, request });
    const reply = generated.reply.trim();
    if (!reply) throw new InputError("话术生成结果为空，请重试");
    return { reply, modelId: generated.modelId, context };
  }

  private async saveOutreach(row: {
    userId: string; profileId: string; taskId: string | null; opportunityId: string | null;
    parentId?: string; channel: OutreachChannel; objective: string; content: string;
    source: "generated" | "rewrite"; version?: number; modelId: string; snapshot: Record<string, unknown>;
  }): Promise<OutreachDraft> {
    const { rows } = await this.pool.query(
      `INSERT INTO de_outreach_drafts
        (id,user_id,profile_id,task_id,opportunity_id,parent_id,channel,objective,content,source,version,input_snapshot,model_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING *`,
      [
        randomUUID(), row.userId, row.profileId, row.taskId, row.opportunityId, row.parentId ?? null,
        row.channel, row.objective, row.content, row.source, row.version ?? 1,
        JSON.stringify(row.snapshot), row.modelId,
      ]
    );
    return toOutreach(rows[0]);
  }

  async getOutreach(userId: string, draftId: string): Promise<OutreachDraft> {
    const { rows } = await this.pool.query(
      `SELECT * FROM de_outreach_drafts WHERE id=$1 AND user_id=$2`, [draftId, userId]
    );
    if (!rows[0]) throw new NotFoundError("未找到该话术");
    return toOutreach(rows[0]);
  }

  async countOpenTasks(userId: string, profileId: string, client: Pool | PoolClient = this.pool): Promise<number> {
    const result = await client.query(
      `SELECT count(*)::int AS count FROM de_follow_up_tasks
       WHERE user_id = $1 AND profile_id = $2 AND status IN ('pending','awaiting_result')`,
      [userId, profileId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async cancelOpenWorkForProfile(userId: string, profileId: string, client: Pool | PoolClient = this.pool): Promise<void> {
    await client.query(
      `UPDATE de_follow_up_tasks
          SET status = 'cancelled', cancelled_at = now(), close_reason = 'profile_archived', version = version + 1
        WHERE user_id = $1 AND profile_id = $2 AND status IN ('pending','awaiting_result')`,
      [userId, profileId]
    );
    await client.query(
      `UPDATE de_follow_up_suggestions
          SET status = 'dismissed', decision_reason = 'profile_archived', decided_at = now(), version = version + 1
        WHERE user_id = $1 AND profile_id = $2 AND status = 'suggested'`,
      [userId, profileId]
    );
    await this.syncProfileCadence(client, userId, profileId);
  }

  private async pendingRows(userId: string, profileId?: string) {
    const params: unknown[] = [userId];
    const profileFilter = profileId ? (params.push(profileId), " AND suggestion.profile_id = $2") : "";
    const result = await this.pool.query(
      `${baseSelect()}
       WHERE suggestion.user_id = $1 AND suggestion.status = 'suggested'
         AND suggestion.opportunity_type <> 'cohort_marketing'
         AND profile.status = 'active'
         AND (suggestion.snoozed_until IS NULL OR suggestion.snoozed_until <= now())
         AND (suggestion.valid_until IS NULL OR suggestion.valid_until >= now())${profileFilter}
       ORDER BY CASE suggestion.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         suggestion.suggested_at DESC`, params
    );
    return result.rows;
  }

  private async actionRows(userId: string, view?: string, actionId?: string, profileId?: string) {
    const conditions = ["task.user_id = $1", "profile.status = 'active'"];
    const params: unknown[] = [userId];
    if (actionId) { params.push(actionId); conditions.push(`task.id = $${params.length}`); }
    if (profileId) { params.push(profileId); conditions.push(`task.profile_id = $${params.length}`); }
    if (view === "today") conditions.push(`(
      (task.status = 'pending' AND task.scheduled_at < date_trunc('day', now()) + interval '1 day')
      OR task.status = 'awaiting_result'
    )`);
    if (view === "in_progress") conditions.push("task.status = 'pending'");
    if (view === "awaiting_result") conditions.push("task.status = 'awaiting_result'");
    if (view === "completed") conditions.push("task.status IN ('completed','cancelled')");
    const result = await this.pool.query(
      `${actionSelect()} WHERE ${conditions.join(" AND ")}
       ORDER BY CASE
         WHEN task.status = 'pending' AND task.scheduled_at < now() THEN 0
         WHEN task.status = 'pending' THEN 1
         WHEN task.status = 'awaiting_result' THEN 2
         ELSE 3
       END,
         CASE WHEN task.status = 'pending' THEN task.scheduled_at END ASC,
         COALESCE(task.completed_at, task.executed_at, task.scheduled_at) DESC`, params
    );
    return result.rows;
  }

  private async discoveryCandidates(userId: string): Promise<DiscoveryCandidate[]> {
    const result = await this.pool.query(
      `SELECT profile.id, profile.display_name, profile.relationship_stage, profile.overall_health,
        profile.summary, profile.last_contact_at, profile.next_follow_up_at, profile.updated_at,
        observation.id AS observation_id, observation.raw_text, observation.occurred_at, observation.event_type,
        COALESCE(jsonb_agg(jsonb_build_object(
          'productKey', product.product_key, 'productName', product.product_name, 'journeyStage', product.journey_stage,
          'satisfaction', product.satisfaction, 'health', product.health, 'currentIssues', product.current_issues,
          'updatedAt', product.updated_at
        )) FILTER (WHERE product.id IS NOT NULL), '[]'::jsonb) AS products
       FROM de_customer_profiles profile
       LEFT JOIN de_customer_product_states product ON product.profile_id = profile.id AND product.user_id = profile.user_id
       LEFT JOIN LATERAL (
         SELECT source.id, source.raw_text, COALESCE(source.occurred_at, source.created_at) AS occurred_at, extraction.event_type
         FROM de_customer_observations source
         LEFT JOIN LATERAL (
           SELECT event_type FROM de_customer_observation_extractions
           WHERE observation_id = source.id AND user_id = source.user_id ORDER BY created_at DESC LIMIT 1
         ) extraction ON true
         WHERE source.profile_id = profile.id AND source.user_id = profile.user_id
         ORDER BY COALESCE(source.occurred_at, source.created_at) DESC LIMIT 1
       ) observation ON true
       WHERE profile.user_id = $1 AND profile.status = 'active'
       GROUP BY profile.id, observation.id, observation.raw_text, observation.occurred_at, observation.event_type
       ORDER BY profile.updated_at DESC LIMIT 500 -- TODO: paginate when accounts exceed 500 profiles`, [userId]
    );
    return result.rows.map((row) => ({
      profileId: row.id, displayName: row.display_name, relationshipStage: row.relationship_stage,
      overallHealth: row.overall_health, summary: row.summary ?? "", lastContactAt: iso(row.last_contact_at),
      nextFollowUpAt: iso(row.next_follow_up_at), updatedAt: iso(row.updated_at)!, products: array(row.products),
      latestObservation: row.observation_id ? { id: row.observation_id, rawText: row.raw_text,
        eventType: row.event_type ?? null, occurredAt: iso(row.occurred_at)! } : null,
    }));
  }

  private async closeStaleActions(userId: string) {
    const closed = await this.pool.query(
      `UPDATE de_follow_up_tasks SET status = 'cancelled', cancelled_at = now(), close_reason = 'overdue_closed', version = version + 1
       WHERE user_id = $1 AND status = 'pending' AND scheduled_at < now() - interval '30 days'
       RETURNING profile_id`, [userId]
    );
    const profileIds = [...new Set(closed.rows.map((row) => String(row.profile_id)))];
    for (const profileId of profileIds) await this.syncProfileCadence(this.pool, userId, profileId);
  }

  /** Keep homepage due-counts and acquisition contact exclusion on the same cadence as tasks. */
  private async syncProfileCadence(
    client: Pool | PoolClient,
    userId: string,
    profileId: string,
    contactAt: string | Date | null = null
  ) {
    await client.query(
      `UPDATE de_customer_profiles SET
         last_contact_at = CASE
           WHEN $3::timestamptz IS NULL THEN last_contact_at
           WHEN last_contact_at IS NULL OR last_contact_at < $3::timestamptz THEN $3::timestamptz
           ELSE last_contact_at
         END,
         last_observed_at = CASE
           WHEN $3::timestamptz IS NULL THEN last_observed_at
           WHEN last_observed_at IS NULL OR last_observed_at < $3::timestamptz THEN $3::timestamptz
           ELSE last_observed_at
         END,
         next_follow_up_at = (
           SELECT MIN(task.scheduled_at) FROM de_follow_up_tasks task
           WHERE task.user_id = $1 AND task.profile_id = $2 AND task.status = 'pending'
         ),
         version = version + 1
       WHERE id = $2 AND user_id = $1 AND status = 'active'`,
      [userId, profileId, contactAt]
    );
  }

  private async recordFollowUpObservation(
    client: PoolClient,
    input: {
      userId: string;
      profileId: string;
      recordId: string;
      taskId: string;
      occurredAt: string | Date;
      method: string | null;
      outcome: string;
      note: string;
      customerQuote: string;
      nextAction: string;
      productKey: string | null;
      productName: string | null;
    }
  ) {
    const observationId = randomUUID();
    const rawText = followUpObservationText(input);
    const inserted = await client.query(
      `INSERT INTO de_customer_observations (
         id, user_id, profile_id, source_type, source_id, source_locator, raw_text, raw_text_hash, occurred_at
       ) VALUES ($1,$2,$3,'manual',$4,$5::jsonb,$6,$7,$8)
       ON CONFLICT (user_id, source_type, source_id) DO NOTHING
       RETURNING id`,
      [
        observationId, input.userId, input.profileId, `follow_up_record:${input.recordId}`,
        JSON.stringify({ kind: "follow_up_result", taskId: input.taskId, recordId: input.recordId }),
        rawText, createHash("sha256").update(rawText).digest("hex"), input.occurredAt,
      ]
    );
    if (!inserted.rows[0]) return;
    await client.query(
      `INSERT INTO de_customer_observation_extractions (
         id, user_id, profile_id, observation_id, event_type, product_key, product_name,
         extracted_facts, proposed_patch, apply_status, prompt_version, schema_version, applied_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'{}'::jsonb,'applied','follow-up-result/v1','customer-observation/v1',now())`,
      [
        randomUUID(), input.userId, input.profileId, inserted.rows[0].id,
        followUpEventType(input.outcome), input.productKey, input.productName,
        JSON.stringify({
          outcome: input.outcome,
          followUpMethod: input.method,
          customerQuote: input.customerQuote || undefined,
          nextAction: input.nextAction || undefined,
        }),
      ]
    );
  }

  private async summary(userId: string): Promise<OpportunitySummary> {
    const result = await this.pool.query(
      `SELECT
        (SELECT count(*) FROM de_follow_up_suggestions suggestion
         JOIN de_customer_profiles profile ON profile.id = suggestion.profile_id AND profile.user_id = suggestion.user_id
         WHERE suggestion.user_id = $1 AND suggestion.status = 'suggested' AND suggestion.priority = 'high'
           AND suggestion.opportunity_type <> 'cohort_marketing'
           AND profile.status = 'active'
           AND (suggestion.snoozed_until IS NULL OR suggestion.snoozed_until <= now())
           AND (suggestion.valid_until IS NULL OR suggestion.valid_until >= now()))::int AS high_priority,
        count(*) FILTER (WHERE task.status = 'pending' AND task.scheduled_at >= now()
          AND task.scheduled_at < date_trunc('day',now()) + interval '1 day')::int AS due_today,
        count(*) FILTER (WHERE task.status = 'pending' AND task.scheduled_at < now())::int AS overdue,
        count(*) FILTER (WHERE task.status = 'awaiting_result')::int AS awaiting_result
       FROM de_follow_up_tasks task
       JOIN de_customer_profiles profile ON profile.id = task.profile_id AND profile.user_id = task.user_id
       WHERE task.user_id = $1 AND profile.status = 'active'`, [userId]
    );
    const row = result.rows[0] ?? {};
    return { highPriority: Number(row.high_priority ?? 0), dueToday: Number(row.due_today ?? 0), overdue: Number(row.overdue ?? 0), awaitingResult: Number(row.awaiting_result ?? 0) };
  }

  private async profileCount(userId: string) {
    const result = await this.pool.query("SELECT count(*)::int AS count FROM de_customer_profiles WHERE user_id = $1 AND status = 'active'", [userId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  private async lastRun(userId: string): Promise<string | null> {
    const result = await this.pool.query(
      "SELECT finished_at FROM de_follow_up_suggestion_runs WHERE user_id = $1 AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1", [userId]
    );
    return iso(result.rows[0]?.finished_at);
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
}

function baseSelect() {
  return `SELECT suggestion.*, profile.display_name, profile.organization, profile.relationship_stage,
    task.id AS action_id, task.status AS action_status, task.scheduled_at, task.result_criteria,
    task.source AS action_source,
    task.executed_at, task.completed_at, task.close_reason, task.version AS action_version,
    record.outcome, record.customer_quote, record.next_action
   FROM de_follow_up_suggestions suggestion
   JOIN de_customer_profiles profile ON profile.id = suggestion.profile_id AND profile.user_id = suggestion.user_id
   LEFT JOIN de_follow_up_tasks task ON task.suggestion_id = suggestion.id AND task.user_id = suggestion.user_id
   LEFT JOIN LATERAL (
     SELECT outcome, customer_quote, next_action FROM de_follow_up_records
     WHERE task_id = task.id AND user_id = suggestion.user_id ORDER BY occurred_at DESC LIMIT 1
   ) record ON true`;
}

function actionSelect() {
  return `SELECT
    COALESCE(suggestion.id, task.id) AS id,
    COALESCE(suggestion.profile_id, task.profile_id) AS profile_id,
    COALESCE(suggestion.opportunity_type, 'prospect_progress') AS opportunity_type,
    COALESCE(suggestion.title, task.title) AS title,
    COALESCE(suggestion.objective, task.objective) AS objective,
    COALESCE(suggestion.follow_up_method, task.follow_up_method) AS follow_up_method,
    COALESCE(suggestion.suggested_at, task.created_at) AS suggested_at,
    COALESCE(suggestion.priority, task.priority) AS priority,
    COALESCE(suggestion.reason, NULLIF(task.note, ''), '用户创建的后续行动') AS reason,
    COALESCE(suggestion.evidence, '[]'::jsonb) AS evidence,
    COALESCE(suggestion.readiness, 'actionable') AS readiness,
    COALESCE(suggestion.risk_flags, '[]'::jsonb) AS risk_flags,
    COALESCE(suggestion.product_key, task.product_key) AS product_key,
    COALESCE(suggestion.product_name, task.product_name) AS product_name,
    suggestion.status, suggestion.snoozed_until,
    profile.display_name, profile.organization, profile.relationship_stage,
    task.id AS action_id, task.status AS action_status, task.scheduled_at, task.result_criteria,
    task.source AS action_source,
    task.executed_at, task.completed_at, task.close_reason, task.version AS action_version,
    record.outcome, record.customer_quote, record.next_action
   FROM de_follow_up_tasks task
   JOIN de_customer_profiles profile ON profile.id = task.profile_id AND profile.user_id = task.user_id
   LEFT JOIN de_follow_up_suggestions suggestion ON suggestion.id = task.suggestion_id AND suggestion.user_id = task.user_id
   LEFT JOIN LATERAL (
     SELECT outcome, customer_quote, next_action FROM de_follow_up_records
     WHERE task_id = task.id AND user_id = task.user_id ORDER BY occurred_at DESC LIMIT 1
   ) record ON true`;
}

function toItem(row: any): OpportunityListItem & { actionVersion?: number } {
  const view = !row.action_id ? "pending" : row.action_status === "pending" ? "in_progress" :
    row.action_status === "awaiting_result" ? "awaiting_result" : "completed";
  return {
    id: row.action_id ?? row.id, view, opportunityId: row.id, actionId: row.action_id ?? null,
    profileId: row.profile_id, customerName: row.display_name, organization: row.organization ?? null,
    relationshipStage: row.relationship_stage, opportunityType: row.opportunity_type,
    source: row.action_source === "manual" ? "manual" : "ai",
    title: row.title, objective: row.objective, followUpMethod: row.follow_up_method ?? null,
    suggestedAt: iso(row.suggested_at)!, scheduledAt: iso(row.scheduled_at), priority: row.priority,
    reason: row.reason, evidence: array(row.evidence), readiness: row.readiness, riskFlags: array(row.risk_flags),
    productKey: row.product_key ?? null, productName: row.product_name ?? null,
    status: row.action_status ?? row.status, snoozedUntil: iso(row.snoozed_until),
    resultCriteria: row.result_criteria ?? null, executedAt: iso(row.executed_at), completedAt: iso(row.completed_at),
    closeReason: row.close_reason ?? null, outcome: row.outcome ?? null, customerQuote: row.customer_quote ?? null,
    nextAction: row.next_action ?? null, overdue: row.action_status === "pending" && Date.parse(row.scheduled_at) < Date.now(),
    ...(row.action_version !== undefined ? { actionVersion: Number(row.action_version) } : {}),
  };
}

function matches(item: OpportunityListItem, filters: OpportunityListFilters) {
  if (filters.profileId && item.profileId !== filters.profileId) return false;
  if (filters.query) {
    const query = filters.query.toLocaleLowerCase("zh-CN");
    const haystack = `${item.customerName} ${item.organization ?? ""}`.toLocaleLowerCase("zh-CN");
    if (!haystack.includes(query)) return false;
  }
  if (filters.readiness && item.readiness !== filters.readiness) return false;
  if (filters.priority && item.priority !== filters.priority) return false;
  if (filters.opportunityType && item.opportunityType !== filters.opportunityType) return false;
  if (filters.relationshipStage && item.relationshipStage !== filters.relationshipStage) return false;
  if (filters.product && !item.productName?.toLowerCase().includes(filters.product.toLowerCase())) return false;
  const suggested = Date.parse(item.suggestedAt);
  if (filters.suggestedFrom && suggested < Date.parse(filters.suggestedFrom)) return false;
  if (filters.suggestedTo && suggested > Date.parse(filters.suggestedTo) + 86_400_000) return false;
  return true;
}

function toSettings(row: any): OpportunitySettings {
  return { enabled: Boolean(row.enabled), timezone: row.timezone, dailyRunTime: String(row.daily_run_time).slice(0, 5),
    nextRunAt: iso(row.next_run_at), lastRunAt: iso(row.last_run_at), version: Number(row.version) };
}

function iso(value: unknown): string | null {
  if (!value) return null;
  return new Date(value as string | Date).toISOString();
}

function array(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
  return [];
}

function dateKey(value: Date) { return value.toISOString().slice(0, 10); }

function defaultResultCriteria(type: string) {
  if (type === "renewal") return "确认续费安排";
  if (type === "risk_recovery") return "确认问题得到处理";
  if (type === "event_invitation") return "确认是否参加活动";
  return "获得有效回复或下一步";
}

/** The model may improve wording only; business facts, type, priority, risks,
 * evidence, time and dedup identity remain server-owned. */
export function applyAdvicePatches(rules: RuleOpportunity[], patches: OpportunityAdvicePatch[]): RuleOpportunity[] {
  const valid = new Map<string, OpportunityAdvicePatch>();
  for (const patch of patches.slice(0, 40)) {
    if (!patch || typeof patch.dedupKey !== "string") continue;
    valid.set(patch.dedupKey, patch);
  }
  return rules.map((rule) => {
    const patch = valid.get(rule.dedupKey);
    if (!patch) return rule;
    return {
      ...rule,
      title: safeAdviceText(patch.title, 300) ?? rule.title,
      objective: safeAdviceText(patch.objective, 2_000) ?? rule.objective,
      method: safeAdviceText(patch.method, 32) ?? rule.method,
      reason: safeAdviceText(patch.reason, 2_000) ?? rule.reason,
    };
  });
}

function safeAdviceText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max && !containsContact(text) ? text : undefined;
}

function redactModelText(value: string, customerName?: string): string {
  let output = value;
  if (customerName) output = output.split(customerName).join("该客户");
  return output
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已隐藏]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已隐藏]");
}

function containsContact(value: string): boolean {
  return /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value) || /(?<!\d)1[3-9]\d{9}(?!\d)/.test(value);
}

function resultLabel(outcome: string) {
  const labels: Record<string, string> = {
    no_response: "无响应", replied: "已回复", interested: "感兴趣", scheduled: "已预约",
    won: "已成交", rejected: "已拒绝", service_needed: "需要服务处理",
  };
  return labels[outcome] ?? outcome;
}

function channelPrompt(channel: OutreachChannel, message: string) {
  const labels: Record<OutreachChannel, string> = {
    wechat: "生成一条可直接发送的微信/企微消息",
    phone: "生成一份电话提纲，包含开场、关键问题和结束下一步",
    email: "生成一封邮件，包含主题、正文和行动号召",
    visit: "生成一份线下回访提纲",
  };
  return `${labels[channel]}。${message}`;
}

function followUpEventType(outcome: string) {
  if (outcome === "service_needed") return "complaint";
  if (outcome === "won") return "purchase";
  return "contact";
}

function followUpObservationText(input: {
  outcome: string;
  method: string | null;
  note: string;
  customerQuote: string;
  nextAction: string;
}) {
  const parts = [
    `跟进结果：${resultLabel(input.outcome)}`,
    input.method ? `方式：${input.method}` : "",
    input.customerQuote ? `客户原话：${input.customerQuote}` : "",
    input.note ? `说明：${input.note}` : "",
    input.nextAction ? `下一步：${input.nextAction}` : "",
  ].filter(Boolean);
  return parts.join("。");
}

function toOutreach(row: any): OutreachDraft {
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id ?? null,
    opportunityId: row.opportunity_id ?? null,
    channel: row.channel,
    objective: row.objective ?? "",
    content: row.content,
    version: Number(row.version),
    usedAt: iso(row.used_at),
    modelId: row.model_id ?? null,
  };
}
