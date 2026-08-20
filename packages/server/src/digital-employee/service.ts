import { randomUUID } from "node:crypto";
import { createSecretBox, sha256Hex, type SecretBox } from "../auth/secret-box.js";
import type { DB } from "../db/database.js";
import { ConflictError, InputError, NotFoundError } from "./errors.js";
import {
  DigitalEmployeeRepository,
  type NewProductStateRow,
  type NewProfileRow,
} from "./repository.js";
import { buildProfileSummary } from "./profile/profile-summary.js";
import {
  buildCohortSnapshot,
  cohortDateKey,
  COHORT_LOCAL_TIME,
  COHORT_TIME_ZONE,
  isCohortNightlyWindow,
  nextCohortRunAt,
  parseLlmCohortSummary,
} from "./profile/cohort-summary.js";
import { productKeyFor, projectObservation } from "./profile/state-projector.js";
import type {
  AddManualObservationInput,
  CommitCaptureInput,
  CommitCaptureResult,
  CommitProfileChangeInput,
  CreateCustomerProfileInput,
  CreateProductStateInput,
  CustomerCaptureInput,
  CustomerObservation,
  CustomerObservationExtraction,
  CustomerProductState,
  CustomerProfile,
  JsonObject,
  ObservationFacts,
  PrepareCaptureResult,
  PrepareProfileChangeResult,
  ProfileChangeInput,
  ProfileListFilters,
  StoredCustomerProfile,
  UpdateCustomerProfileInput,
  UpdateProductStateInput,
} from "./types.js";
import { parseCaptureInput } from "./validators.js";
import { MarketingMaterialsService } from "./marketing-service.js";
import { OpportunityService, type OpportunityTalkTrackGenerator } from "./opportunity-service.js";
import type { JobQueue } from "@lot-agent/core";
import { CustomerAcquisitionService } from "./acquisition-service.js";
import type { CampaignContentGenerator, CampaignModelResolver } from "./acquisition-types.js";

const CAPTURE_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;
const CAPTURE_PROMPT_VERSION = "customer-capture/v1";
const CAPTURE_SCHEMA_VERSION = "customer-observation/v1";
const PROFILE_CHANGE_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface CaptureSourceContext {
  conversationId?: string;
  sourceMessageId?: string;
  sourceText?: string;
  modelId?: string;
}

interface ApplyObservationArgs {
  profile: StoredCustomerProfile;
  rawText: string;
  sourceType: "agent_message" | "manual";
  sourceId: string;
  sourceLocator: JsonObject;
  input: {
    eventType: CustomerCaptureInput["eventType"];
    productName?: string;
    occurredAt?: string | null;
    facts?: ObservationFacts;
    proposedStatePatch?: ObservationFacts;
    confidence?: number | null;
    confirmedJourneyStage?: CustomerProductState["journeyStage"];
  };
  actor: "user" | "ai_confirmed";
  modelId?: string;
}

interface AppliedObservation {
  profile: StoredCustomerProfile;
  observation: CustomerObservation;
  extraction: CustomerObservationExtraction;
  products: CustomerProductState[];
  appliedFields: string[];
  skippedFields: string[];
}

export interface CohortSummaryGenerator {
  generate(input: {
    userId: string;
    snapshotDate: string;
    metrics: import("./types.js").CustomerCohortMetrics;
  }): Promise<{ summary: string; modelId: string }>;
}

/**
 * Application service for customer profiles. It owns permissions, encryption,
 * transactions and optimistic concurrency; SQL remains in the repository and
 * field-transition policy remains in pure profile/state-projector.ts.
 */
export class DigitalEmployeeService {
  readonly repository: DigitalEmployeeRepository;
  readonly marketingMaterials: MarketingMaterialsService;
  readonly opportunities: OpportunityService;
  readonly customerAcquisition: CustomerAcquisitionService;
  private readonly secretBox: SecretBox;

  constructor(
    private readonly db: DB,
    secretBox: SecretBox = createSecretBox(),
    private readonly cohortSummaryGenerator?: CohortSummaryGenerator,
    opportunityQueue?: JobQueue,
    opportunityTalkTrackGenerator?: OpportunityTalkTrackGenerator,
    acquisitionDeps?: {
      contentGenerator?: CampaignContentGenerator;
      modelResolver?: CampaignModelResolver;
    }
  ) {
    this.repository = new DigitalEmployeeRepository(db.pool);
    this.marketingMaterials = new MarketingMaterialsService(db);
    this.opportunities = new OpportunityService(db, opportunityQueue, undefined, opportunityTalkTrackGenerator);
    this.customerAcquisition = new CustomerAcquisitionService(
      db,
      opportunityQueue,
      acquisitionDeps?.contentGenerator,
      acquisitionDeps?.modelResolver,
    );
    this.secretBox = secretBox;
  }

  async listProfiles(userId: string, filters: ProfileListFilters) {
    const result = await this.repository.listProfiles(userId, filters);
    return { ...result, items: result.items.map((profile) => this.publicProfile(profile, false)) };
  }

  async getOverview(userId: string, now: Date = new Date()) {
    const [recent, storedSnapshot] = await Promise.all([
      this.repository.listProfiles(userId, { page: 1, limit: 5, status: "active" }),
      this.repository.getLatestCohortSnapshot(userId),
    ]);
    const snapshot = storedSnapshot ?? buildCohortSnapshot(
      await this.repository.listActiveProfilesForCohort(userId),
      now
    );
    return {
      recentProfiles: recent.items.map((profile) => this.publicProfile(profile, false)),
      totalProfiles: recent.total,
      cohort: { ...snapshot, source: storedSnapshot ? "nightly" as const : "live" as const },
      schedule: {
        enabled: true as const,
        timeZone: COHORT_TIME_ZONE,
        localTime: COHORT_LOCAL_TIME,
        nextRunAt: nextCohortRunAt(now),
      },
    };
  }

  /**
   * Idempotent account-level scheduler target. The server calls it repeatedly;
   * a user/date primary key means each account is summarized once per local day.
   */
  async runNightlyCohortSummaries(now: Date = new Date()): Promise<number> {
    if (!isCohortNightlyWindow(now)) return 0;
    const snapshotDate = cohortDateKey(now);
    const userIds = await this.repository.listUsersMissingCohortSnapshot(snapshotDate);
    let completed = 0;
    for (const userId of userIds) {
      try {
        const profiles = await this.repository.listActiveProfilesForCohort(userId);
        const logicSnapshot = buildCohortSnapshot(profiles, now);
        let snapshot = logicSnapshot;
        if (this.cohortSummaryGenerator) {
          try {
            const generated = await this.cohortSummaryGenerator.generate({
              userId,
              snapshotDate,
              metrics: logicSnapshot.metrics,
            });
            snapshot = {
              ...logicSnapshot,
              summary: parseLlmCohortSummary(generated.summary),
              generationMethod: "llm",
              modelId: generated.modelId,
            };
          } catch (error) {
            console.warn(`[digital-employee] LLM cohort summary degraded to logic for user ${userId}:`, error);
          }
        }
        await this.repository.upsertCohortSnapshot(userId, snapshot);
        completed += 1;
      } catch (error) {
        console.warn(`[digital-employee] cohort summary failed for user ${userId}:`, error);
      }
    }
    return completed;
  }

  async getProfile(userId: string, profileId: string): Promise<{ profile: CustomerProfile; productStates: CustomerProductState[] }> {
    const profile = await this.requireProfile(userId, profileId);
    const products = await this.repository.listProductStates(userId, profileId);
    return { profile: this.publicProfile(profile, true), productStates: products };
  }

  /** Agent-facing search never includes decrypted contact information. */
  async searchProfilesForAgent(
    userId: string,
    filters: Omit<ProfileListFilters, "page" | "limit" | "status"> & { page?: number; limit?: number }
  ) {
    return this.listProfiles(userId, {
      ...filters,
      page: filters.page ?? 1,
      limit: Math.min(filters.limit ?? 6, 20),
      status: "active",
    });
  }

  /** Bounded, redacted detail view used in model context. */
  async getProfilesForAgent(userId: string, profileIds: string[]) {
    const ids = [...new Set(profileIds)];
    if (!ids.length || ids.length > 6) throw new InputError("一次只能读取1到6条客户画像");
    return Promise.all(ids.map(async (profileId) => {
      const profile = await this.requireProfile(userId, profileId);
      if (profile.status !== "active") throw new NotFoundError();
      const [productStates, observations] = await Promise.all([
        this.repository.listProductStates(userId, profileId),
        this.repository.listObservations(userId, profileId, 1, 5),
      ]);
      return {
        profile: this.publicProfile(profile, false),
        productStates,
        recentObservations: observations.items.map((item) => ({
          id: item.id,
          sourceType: item.sourceType,
          rawText: item.rawText.slice(0, 1_000),
          occurredAt: item.occurredAt,
          createdAt: item.createdAt,
        })),
      };
    }));
  }

  async rememberCurrentProfile(userId: string, conversationId: string | undefined, profile: Pick<CustomerProfile, "id" | "displayName">) {
    if (!conversationId) return;
    const owned = await this.requireProfile(userId, profile.id);
    if (owned.status !== "active") throw new NotFoundError();
    await this.db.setConversationCustomerContext(conversationId, userId, {
      id: owned.id,
      displayName: owned.displayName,
    });
  }

  async clearCurrentProfile(userId: string, conversationId: string): Promise<void> {
    const cleared = await this.db.setConversationCustomerContext(conversationId, userId, null);
    if (!cleared) throw new NotFoundError();
  }

  async prepareProfileChange(
    userId: string,
    input: ProfileChangeInput,
    source: CaptureSourceContext
  ): Promise<PrepareProfileChangeResult> {
    const mention = (input.customerMention ?? input.displayName ?? "").trim();
    if (!mention) throw new InputError("请提供客户名称或称呼");
    const contextual = await this.contextProfileForMention(userId, source.conversationId, mention);
    let candidates = contextual ? [contextual] : await this.repository.findProfilesByExactMention(userId, mention);
    let usedFuzzyFallback = false;
    if (input.operation === "update" && candidates.length === 0) {
      const fuzzy = await this.repository.listProfiles(userId, { page: 1, limit: 5, query: mention, status: "active" });
      candidates = fuzzy.items;
      usedFuzzyFallback = candidates.length > 0;
    }

    const proposedPatch = profileChangePatch(input);
    if (input.operation === "create" && typeof proposedPatch.displayName !== "string") {
      proposedPatch.displayName = mention;
    }
    if (input.operation === "update" && Object.keys(proposedPatch).length === 0) {
      throw new InputError("没有可更新的画像字段");
    }

    const risks: string[] = [];
    if (input.operation === "create" && candidates.length) risks.push("possible_duplicate");
    if (input.operation === "update" && (candidates.length !== 1 || usedFuzzyFallback)) {
      risks.push(candidates.length ? "identity_ambiguous" : "profile_not_found");
    }
    if (input.operation === "update" && ["displayName", "aliases", "relationshipStage"].some((field) => field in proposedPatch)) {
      risks.push("high_impact_field");
    }
    const target = input.operation === "update" && candidates.length === 1 ? candidates[0] : undefined;
    const draft = await this.repository.createProfileChangeDraft({
      id: randomUUID(),
      userId,
      conversationId: source.conversationId ?? null,
      sourceMessageId: source.sourceMessageId ?? null,
      operation: input.operation,
      customerMention: mention,
      candidateProfileIds: candidates.map((item) => item.id),
      proposedPatch,
      targetVersion: target?.version ?? null,
      risks,
      status: risks.length ? "awaiting_confirmation" : "prepared",
      expiresAt: new Date(Date.now() + PROFILE_CHANGE_DRAFT_TTL_MS).toISOString(),
    });
    const maxCandidateOptions = risks.includes("possible_duplicate") ? 4 : 5;
    const views = candidates.slice(0, maxCandidateOptions).map((item) => ({
      id: item.id,
      displayName: item.displayName,
      customerRegion: item.customerRegion,
    }));
    const result: PrepareProfileChangeResult = {
      draftId: draft.id,
      status: draft.status === "awaiting_confirmation" ? "needs_confirmation" : "ready",
      operation: draft.operation,
      candidates: views,
      risks: draft.risks,
    };
    if (draft.risks.includes("possible_duplicate")) {
      result.question = `已找到可能重复的“${mention}”画像，要使用已有画像还是继续新建？`;
      result.options = [...views.map(displayCandidate), "继续新建", "取消"];
    } else if (draft.risks.includes("identity_ambiguous")) {
      result.question = `“${mention}”对应哪位客户？${draft.risks.includes("high_impact_field") ? "选择后将应用本次关键字段修改。" : ""}`;
      result.options = views.map(displayCandidate);
    } else if (draft.risks.includes("profile_not_found")) {
      result.question = `未找到“${mention}”的客户画像，请提供更准确的名称或先新建画像。`;
      result.options = ["重新描述", "取消"];
    } else if (draft.risks.includes("high_impact_field")) {
      result.question = `本次将修改“${mention}”的关键画像字段，是否确认？`;
      result.options = ["确认修改", "取消"];
    }
    return result;
  }

  async commitProfileChange(
    userId: string,
    input: CommitProfileChangeInput,
    source: Pick<CaptureSourceContext, "conversationId"> = {}
  ): Promise<CustomerProfile> {
    const result = await this.repository.transaction(async (client) => {
      const draft = await this.repository.getProfileChangeDraft(userId, input.draftId, client, true);
      if (!draft) throw new NotFoundError();
      if (draft.status === "applied") {
        if (!draft.appliedProfileId) throw new ConflictError("画像变更草稿状态异常");
        const applied = await this.repository.getProfile(userId, draft.appliedProfileId, client);
        if (!applied) throw new NotFoundError();
        return this.publicProfile(applied, false);
      }
      if (draft.status === "expired" || new Date(draft.expiresAt).getTime() < Date.now()) {
        throw new InputError("画像变更草稿已过期，请重新操作");
      }
      if (draft.risks.includes("profile_not_found")) throw new InputError("没有可更新的目标画像");
      if (draft.risks.includes("possible_duplicate") && !input.continueCreate) {
        throw new InputError("请先确认是否继续新建；如需修改已有画像，请重新发起更新");
      }
      if (draft.risks.includes("high_impact_field") && !input.confirm) {
        throw new InputError("请先确认关键字段修改");
      }

      let saved: StoredCustomerProfile;
      if (draft.operation === "create") {
        const create = draft.proposedPatch as CreateCustomerProfileInput;
        const profileId = randomUUID();
        saved = await this.repository.createProfile(
          this.newProfileRow(userId, profileId, create, buildProfileSummary(profileSummaryInput(create), [])),
          client
        );
      } else {
        let profileId = draft.risks.includes("identity_ambiguous")
          ? input.profileId
          : draft.candidateProfileIds.length === 1
            ? draft.candidateProfileIds[0]
            : input.profileId;
        if (!profileId || !draft.candidateProfileIds.includes(profileId)) {
          throw new InputError("请选择当前草稿中的唯一目标画像");
        }
        const current = await this.repository.getProfile(userId, profileId, client);
        if (!current || current.status !== "active") throw new NotFoundError();
        if (draft.targetVersion !== null && current.version !== draft.targetVersion) throw new ConflictError();
        const products = await this.repository.listProductStates(userId, profileId, client);
        const next = this.mergeProfile(current, {
          ...(draft.proposedPatch as Omit<UpdateCustomerProfileInput, "version">),
          version: current.version,
        });
        next.summary = buildProfileSummary(profileSummaryShape(next), products);
        next.summaryVersion = current.summaryVersion + 1;
        const updated = await this.repository.saveProfile(userId, next, current.version, client);
        if (!updated) throw new ConflictError();
        saved = updated;
        const patch = profileStatePatch(current, saved);
        if (Object.keys(patch).length) {
          await this.repository.createStateChange({
            id: randomUUID(), userId, profileId, actorType: "ai_confirmed",
            beforeState: profileStateSnapshot(current), patch, afterState: profileStateSnapshot(saved),
            reason: "数字员工对话更新画像",
          }, client);
        }
      }
      await this.repository.markProfileChangeDraftApplied(userId, draft.id, saved.id, client);
      return this.publicProfile(saved, false);
    });
    await this.rememberCurrentProfile(userId, source.conversationId, result).catch(() => {});
    return result;
  }

  async createProfile(
    userId: string,
    input: CreateCustomerProfileInput
  ): Promise<{ profile: CustomerProfile; productStates: CustomerProductState[] }> {
    return this.repository.transaction(async (client) => {
      const productRows = (input.productStates ?? []).map((state) => this.newProductRow(userId, "", state));
      const seenKeys = new Set<string>();
      for (const product of productRows) {
        if (seenKeys.has(product.productKey)) throw new InputError("产品名称不能重复");
        seenKeys.add(product.productKey);
      }
      const profileId = randomUUID();
      const productsForSummary = productRows.map((item) => productSummaryShape(item));
      const profile = await this.repository.createProfile(
        this.newProfileRow(userId, profileId, input, buildProfileSummary(profileSummaryInput(input), productsForSummary)),
        client
      );
      const products: CustomerProductState[] = [];
      for (const row of productRows) {
        const created = await this.repository.createProductState({ ...row, profileId }, client);
        products.push(created);
        await this.repository.createStateChange(
          {
            id: randomUUID(), userId, profileId, productStateId: created.id, actorType: "user",
            beforeState: {}, patch: productStateSnapshot(created), afterState: productStateSnapshot(created),
            reason: "手工创建产品关系",
          },
          client
        );
      }
      return { profile: this.publicProfile(profile, true), productStates: products };
    });
  }

  async updateProfile(userId: string, profileId: string, input: UpdateCustomerProfileInput): Promise<CustomerProfile> {
    return this.repository.transaction(async (client) => {
      const current = await this.repository.getProfile(userId, profileId, client);
      if (!current || current.status !== "active") throw new NotFoundError();
      const products = await this.repository.listProductStates(userId, profileId, client);
      const next = this.mergeProfile(current, input);
      next.summary = buildProfileSummary(profileSummaryShape(next), products);
      next.summaryVersion = current.summaryVersion + 1;
      const saved = await this.repository.saveProfile(userId, next, input.version, client);
      if (!saved) throw new ConflictError();
      const patch = profileStatePatch(current, saved);
      if (Object.keys(patch).length) {
        await this.repository.createStateChange(
          {
            id: randomUUID(), userId, profileId, actorType: "user",
            beforeState: profileStateSnapshot(current), patch, afterState: profileStateSnapshot(saved),
            reason: "手工更新画像状态",
          },
          client
        );
      }
      return this.publicProfile(saved, true);
    });
  }

  async archiveProfile(userId: string, profileId: string, version: number): Promise<CustomerProfile> {
    const existing = await this.repository.getProfile(userId, profileId);
    if (!existing || existing.status !== "active") throw new NotFoundError();
    const archived = await this.repository.archiveProfile(userId, profileId, version);
    if (!archived) throw new ConflictError();
    return this.publicProfile(archived, true);
  }

  async updateProductState(
    userId: string,
    profileId: string,
    productKey: string,
    input: UpdateProductStateInput
  ): Promise<{ profile: CustomerProfile; productState: CustomerProductState }> {
    return this.repository.transaction(async (client) => {
      const profile = await this.repository.getProfile(userId, profileId, client);
      if (!profile || profile.status !== "active") throw new NotFoundError();
      const current = await this.repository.getProductState(userId, profileId, productKey, client);
      let savedState: CustomerProductState;
      if (!current) {
        if (input.version !== undefined) throw new InputError("新产品状态不应携带version");
        const name = input.productName?.trim();
        if (!name) throw new InputError("新产品状态需要productName");
        savedState = await this.repository.createProductState(
          this.newProductRow(userId, profileId, { productName: name, productKey, ...input }),
          client
        );
      } else {
        if (input.version === undefined) throw new InputError("更新产品状态需要version");
        const next: CustomerProductState = {
          ...current,
          productName: input.productName ?? current.productName,
          journeyStage: input.journeyStage ?? current.journeyStage,
          sentiment: input.sentiment ?? current.sentiment,
          satisfaction: input.satisfaction ?? current.satisfaction,
          health: input.health ?? current.health,
          needs: input.needs ?? current.needs,
          objections: input.objections ?? current.objections,
          currentIssues: input.currentIssues ?? current.currentIssues,
          manualLockFields: input.manualLockFields ?? current.manualLockFields,
          lastConfirmedAt: new Date().toISOString(),
        };
        const saved = await this.repository.saveProductState(userId, next, input.version, client);
        if (!saved) throw new ConflictError();
        savedState = saved;
      }
      const allProducts = await this.repository.listProductStates(userId, profileId, client);
      const nextProfile: StoredCustomerProfile = {
        ...profile,
        summary: buildProfileSummary(profileSummaryShape(profile), allProducts),
        summaryVersion: profile.summaryVersion + 1,
      };
      const savedProfile = await this.repository.saveProfile(userId, nextProfile, profile.version, client);
      if (!savedProfile) throw new ConflictError();
      await this.repository.createStateChange(
        {
          id: randomUUID(), userId, profileId, productStateId: savedState.id, actorType: "user",
          beforeState: current ? productStateSnapshot(current) : {},
          patch: current ? productStatePatch(current, savedState) : productStateSnapshot(savedState),
          afterState: productStateSnapshot(savedState), reason: "手工修正产品状态",
        },
        client
      );
      return { profile: this.publicProfile(savedProfile, true), productState: savedState };
    });
  }

  async addManualObservation(
    userId: string,
    profileId: string,
    input: AddManualObservationInput
  ): Promise<CommitCaptureResult> {
    return this.repository.transaction(async (client) => {
      const profile = await this.repository.getProfile(userId, profileId, client);
      if (!profile || profile.status !== "active") throw new NotFoundError();
      const applied = await this.applyObservation(client, userId, {
        profile,
        rawText: input.rawText,
        sourceType: "manual",
        sourceId: `manual:${randomUUID()}`,
        sourceLocator: { source: "profile_page" },
        input: { ...input, eventType: input.eventType ?? "note" },
        actor: "user",
      });
      return this.commitResult(applied, true);
    });
  }

  async listObservations(userId: string, profileId: string, page: number, limit: number) {
    await this.requireProfile(userId, profileId);
    return this.repository.listObservations(userId, profileId, page, limit);
  }

  async listStateChanges(userId: string, profileId: string, page: number, limit: number) {
    await this.requireProfile(userId, profileId);
    return this.repository.listStateChanges(userId, profileId, page, limit);
  }

  async prepareCustomerCapture(
    userId: string,
    input: CustomerCaptureInput,
    source: CaptureSourceContext
  ): Promise<PrepareCaptureResult> {
    if (!source.sourceText?.trim()) throw new InputError("当前消息没有可保存的原始客户记录");
    const rawText = source.sourceText.trim().slice(0, 12_000);
    const contextual = await this.contextProfileForMention(userId, source.conversationId, input.customerMention);
    const candidates = contextual ? [contextual] : await this.repository.findProfilesByExactMention(userId, input.customerMention);
    const candidateViews = candidates.map((profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      customerRegion: profile.customerRegion,
    }));
    const ambiguities = [...(input.uncertainties ?? [])];
    let selected = candidates.length === 1 ? candidates[0] : undefined;
    let clarification: PrepareCaptureResult["clarification"];

    if (candidates.length === 0) {
      ambiguities.push("new_profile");
      clarification = {
        kind: "new_profile",
        question: `未找到“${input.customerMention}”的客户画像，是否新建？`,
        options: ["新建客户画像", "暂不记录"],
      };
    } else if (candidates.length > 1) {
      ambiguities.push("identity");
      clarification = {
        kind: "identity",
        question: `“${input.customerMention}”对应哪位客户？`,
        options: candidateViews.map((candidate) => displayCandidate(candidate)),
      };
    } else {
      const product = input.productName
        ? await this.repository.getProductState(userId, selected!.id, productKeyFor(input.productName))
        : undefined;
      const projected = projectObservation(this.publicProfile(selected!, false), product ?? undefined, {
        eventType: input.eventType,
        facts: input.facts,
        proposedPatch: input.proposedStatePatch,
        actor: "ai_confirmed",
      });
      const explicitlyUncertain = ambiguities.includes("product_journey_stage");
      if (projected.requiresJourneyConfirmation || explicitlyUncertain) {
        if (!ambiguities.includes("product_journey_stage")) ambiguities.push("product_journey_stage");
        clarification = {
          kind: "journey_stage",
          question: `${selected!.displayName}目前与${input.productName ?? "该产品"}是什么关系？`,
          options: ["已购买正在使用", "正在试用", "仍在评估", "已经放弃购买"],
        };
      }
    }

    const draftId = randomUUID();
    await this.repository.createDraft({
      id: draftId,
      userId,
      conversationId: source.conversationId ?? null,
      sourceMessageId: source.sourceMessageId ?? null,
      rawText,
      candidateProfileIds: candidates.map((candidate) => candidate.id),
      proposedObservation: compact({
        capture: input,
        profileId: selected?.id,
        modelId: source.modelId,
      }),
      ambiguities: [...new Set(ambiguities)],
      status: clarification ? "awaiting_confirmation" : "prepared",
      expiresAt: new Date(Date.now() + CAPTURE_DRAFT_TTL_MS).toISOString(),
    });

    return {
      draftId,
      status: clarification ? "needs_clarification" : "ready",
      profile: selected ? { id: selected.id, displayName: selected.displayName } : undefined,
      candidates: candidateViews,
      ambiguities: [...new Set(ambiguities)],
      clarification,
    };
  }

  async commitCustomerCapture(
    userId: string,
    input: CommitCaptureInput,
    source: Pick<CaptureSourceContext, "conversationId"> = {}
  ): Promise<CommitCaptureResult> {
    const result = await this.repository.transaction(async (client) => {
      const draft = await this.repository.getDraft(userId, input.draftId, client, true);
      if (!draft) throw new NotFoundError();
      if (draft.status === "expired" || new Date(draft.expiresAt).getTime() < Date.now()) {
        throw new InputError("采集草稿已过期，请重新记录客户情况");
      }
      if (draft.status === "applied") {
        if (!draft.appliedProfileId || !draft.appliedObservationId) throw new ConflictError("采集草稿状态异常，请重新记录");
        const [profile, observation, extraction] = await Promise.all([
          this.repository.getProfile(userId, draft.appliedProfileId, client),
          this.repository.getObservationBySource(userId, "agent_message", sourceIdForDraft(draft, draft.appliedProfileId), client),
          this.repository.getLatestExtractionForObservation(userId, draft.appliedObservationId, client),
        ]);
        if (!profile || !observation || !extraction) throw new ConflictError("已提交记录无法完整读取，请刷新后重试");
        return {
          profile: this.publicProfile(profile, true), observation, extraction,
          appliedFields: [], skippedFields: [], alreadyApplied: true,
        };
      }
      if (draft.status !== "prepared" && draft.status !== "awaiting_confirmation") {
        throw new InputError("该采集草稿不能提交");
      }

      const proposal = draft.proposedObservation;
      const capture = parseCaptureInput(proposal.capture);
      const storedProfileId = stringValue(proposal.profileId);
      const modelId = stringValue(proposal.modelId);
      let profileId = storedProfileId;

      if (draft.candidateProfileIds.length > 1) {
        if (!input.profileId) throw new InputError("请先确认要记录到哪位客户画像");
        if (!draft.candidateProfileIds.includes(input.profileId)) throw new InputError("选择的客户不在当前候选范围内");
        profileId = input.profileId;
      } else if (draft.candidateProfileIds.length === 1 && input.profileId && input.profileId !== draft.candidateProfileIds[0]) {
        throw new InputError("选择的客户与采集草稿不一致");
      }

      let profile: StoredCustomerProfile | null = profileId
        ? await this.repository.getProfile(userId, profileId, client)
        : null;
      if (!profile && draft.ambiguities.includes("new_profile")) {
        if (!input.createProfile) throw new InputError("请先确认是否新建客户画像");
        const displayName = input.createProfile.displayName?.trim() || capture.customerMention;
        if (!displayName || displayName.length > 200) throw new InputError("新客户名称无效");
        const profileIdForNew = randomUUID();
        profile = await this.repository.createProfile(
          this.newProfileRow(userId, profileIdForNew, { displayName }, `${displayName}：线索，整体健康。`),
          client
        );
      }
      if (!profile || profile.status !== "active") throw new NotFoundError();
      if (draft.ambiguities.includes("product_journey_stage") && !input.confirmedJourneyStage) {
        throw new InputError("请先确认客户当前的产品阶段");
      }

      const applied = await this.applyObservation(client, userId, {
        profile,
        rawText: draft.rawText,
        sourceType: "agent_message",
        sourceId: sourceIdForDraft(draft, profile.id),
        sourceLocator: compact({
          conversationId: draft.conversationId,
          sourceMessageId: draft.sourceMessageId,
          draftId: draft.id,
        }),
        input: {
          ...capture,
          confirmedJourneyStage: input.confirmedJourneyStage,
        },
        actor: "ai_confirmed",
        modelId,
      });
      await this.repository.markDraftApplied(userId, draft.id, profile.id, applied.observation.id, client);
      return this.commitResult(applied, true);
    });
    await this.rememberCurrentProfile(userId, source.conversationId, result.profile).catch(() => {});
    return result;
  }

  private async contextProfileForMention(
    userId: string,
    conversationId: string | undefined,
    mention: string
  ): Promise<StoredCustomerProfile | null> {
    if (!conversationId || !isContextReference(mention)) return null;
    const context = await this.db.getConversationCustomerContext(conversationId, userId);
    if (!context) return null;
    const profile = await this.repository.getProfile(userId, context.id);
    if (!profile || profile.status !== "active") {
      await this.db.setConversationCustomerContext(conversationId, userId, null);
      return null;
    }
    return profile;
  }

  private async applyObservation(
    client: Parameters<DigitalEmployeeRepository["transaction"]>[0] extends (client: infer T) => unknown ? T : never,
    userId: string,
    args: ApplyObservationArgs
  ): Promise<AppliedObservation> {
    const existing = await this.repository.getObservationBySource(userId, args.sourceType, args.sourceId, client);
    if (existing) {
      const [profile, extraction, products] = await Promise.all([
        this.repository.getProfile(userId, existing.profileId, client),
        this.repository.getLatestExtractionForObservation(userId, existing.id, client),
        this.repository.listProductStates(userId, existing.profileId, client),
      ]);
      if (!profile || !extraction) throw new ConflictError("已有记录不完整，请刷新后重试");
      return {
        profile,
        observation: existing,
        extraction,
        products,
        appliedFields: [],
        skippedFields: [],
      };
    }

    const observation = await this.repository.createObservation(
      {
        id: randomUUID(), userId, profileId: args.profile.id, sourceType: args.sourceType,
        sourceId: args.sourceId, sourceLocator: args.sourceLocator, rawText: args.rawText,
        rawTextHash: sha256Hex(args.rawText), occurredAt: args.input.occurredAt ?? null,
      },
      client
    );
    if (!observation) throw new ConflictError("客户记录已被重复提交，请刷新后重试");

    const productKey = args.input.productName ? productKeyFor(args.input.productName) : undefined;
    const currentProduct = productKey
      ? await this.repository.getProductState(userId, args.profile.id, productKey, client)
      : null;
    const projection = projectObservation(this.publicProfile(args.profile, false), currentProduct ?? undefined, {
      eventType: args.input.eventType,
      facts: args.input.facts,
      proposedPatch: args.input.proposedStatePatch,
      confirmedJourneyStage: args.input.confirmedJourneyStage,
      actor: args.actor,
    });
    if (projection.requiresJourneyConfirmation) {
      // This only happens if someone tries to bypass prepare/commit. Persisting
      // neither the observation nor the model extraction is safer than writing
      // a high-impact state based on an unconfirmed inference.
      throw new InputError("产品阶段尚未确认，不能提交客户记录");
    }

    const applyStatus = projection.skippedFields.length ? "partial" : "applied";
    const extraction = await this.repository.createExtraction(
      {
        id: randomUUID(), userId, profileId: args.profile.id, observationId: observation.id,
        eventType: args.input.eventType, productKey: productKey ?? null,
        productName: args.input.productName ?? null, extractedFacts: compact(args.input.facts ?? {}),
        proposedPatch: compact(args.input.proposedStatePatch ?? {}), applyStatus,
        confidence: args.input.confidence ?? null, modelId: args.modelId ?? null,
        promptVersion: CAPTURE_PROMPT_VERSION, schemaVersion: CAPTURE_SCHEMA_VERSION,
        appliedAt: new Date().toISOString(),
      },
      client
    );

    let savedProduct = currentProduct ?? undefined;
    if (args.input.productName && productKey) {
      const base = currentProduct ?? this.emptyProductState(userId, args.profile.id, productKey, args.input.productName);
      const nextProduct: CustomerProductState = {
        ...base,
        ...projection.productPatch,
        lastObservationId: observation.id,
        lastConfirmedAt: args.actor === "user" || args.input.confirmedJourneyStage ? new Date().toISOString() : base.lastConfirmedAt,
      };
      if (currentProduct) {
        const saved = await this.repository.saveProductState(userId, nextProduct, currentProduct.version, client);
        if (!saved) throw new ConflictError();
        savedProduct = saved;
      } else {
        savedProduct = await this.repository.createProductState(
          {
            id: nextProduct.id, userId, profileId: args.profile.id, productKey, productName: nextProduct.productName,
            journeyStage: nextProduct.journeyStage, sentiment: nextProduct.sentiment,
            satisfaction: nextProduct.satisfaction, health: nextProduct.health,
            needs: nextProduct.needs, objections: nextProduct.objections, currentIssues: nextProduct.currentIssues,
            manualLockFields: nextProduct.manualLockFields, lastObservationId: observation.id,
            lastConfirmedAt: nextProduct.lastConfirmedAt,
          },
          client
        );
      }
    }

    const allProducts = await this.repository.listProductStates(userId, args.profile.id, client);
    const observedAt = args.input.occurredAt ?? new Date().toISOString();
    const nextProfile: StoredCustomerProfile = {
      ...args.profile,
      ...projection.profilePatch,
      lastObservedAt: observedAt,
      lastContactAt: args.input.eventType === "contact" ? observedAt : args.profile.lastContactAt,
      summary: buildProfileSummary(profileSummaryShape({ ...args.profile, ...projection.profilePatch }), allProducts),
      summaryVersion: args.profile.summaryVersion + 1,
    };
    const savedProfile = await this.repository.saveProfile(userId, nextProfile, args.profile.version, client);
    if (!savedProfile) throw new ConflictError();

    if (Object.keys(projection.profilePatch).length) {
      await this.repository.createStateChange(
        {
          id: randomUUID(), userId, profileId: args.profile.id, sourceObservationId: observation.id,
          sourceExtractionId: extraction.id, actorType: args.actor,
          beforeState: profileStateSnapshot(args.profile), patch: compact(projection.profilePatch),
          afterState: profileStateSnapshot(savedProfile), reason: "客户观察推动的总体状态更新",
        },
        client
      );
    }
    if (savedProduct && (!currentProduct || Object.keys(projection.productPatch).length)) {
      await this.repository.createStateChange(
        {
          id: randomUUID(), userId, profileId: args.profile.id, productStateId: savedProduct.id,
          sourceObservationId: observation.id, sourceExtractionId: extraction.id, actorType: args.actor,
          beforeState: currentProduct ? productStateSnapshot(currentProduct) : {},
          patch: currentProduct ? compact(projection.productPatch) : productStateSnapshot(savedProduct),
          afterState: productStateSnapshot(savedProduct), reason: "客户观察推动的产品状态更新",
        },
        client
      );
    }
    return {
      profile: savedProfile,
      observation,
      extraction,
      products: allProducts,
      appliedFields: [...Object.keys(projection.profilePatch), ...Object.keys(projection.productPatch)],
      skippedFields: projection.skippedFields,
    };
  }

  private commitResult(applied: AppliedObservation, includeContact: boolean): CommitCaptureResult {
    return {
      profile: this.publicProfile(applied.profile, includeContact),
      observation: applied.observation,
      extraction: applied.extraction,
      appliedFields: applied.appliedFields,
      skippedFields: applied.skippedFields,
    };
  }

  private async requireProfile(userId: string, profileId: string): Promise<StoredCustomerProfile> {
    const profile = await this.repository.getProfile(userId, profileId);
    if (!profile) throw new NotFoundError();
    return profile;
  }

  private newProfileRow(
    userId: string,
    profileId: string,
    input: Pick<CreateCustomerProfileInput, "displayName"> & Partial<CreateCustomerProfileInput>,
    summary: string
  ): NewProfileRow {
    return {
      id: profileId,
      userId,
      ownerUserId: userId,
      displayName: input.displayName.trim(),
      aliases: input.aliases ?? [],
      customerKind: input.customerKind ?? "person",
      organization: input.organization ?? null,
      department: input.department ?? null,
      title: input.title ?? null,
      customerRegion: input.customerRegion ?? null,
      contactCiphertext: this.sealContact(input.contact),
      source: input.source ?? null,
      relationshipStage: input.relationshipStage ?? "lead",
      overallHealth: input.overallHealth ?? "healthy",
      tags: input.tags ?? [],
      customFields: input.customFields ?? {},
      summary,
      summaryVersion: 1,
      manualLockFields: input.manualLockFields ?? [],
    };
  }

  private newProductRow(userId: string, profileId: string, input: CreateProductStateInput): NewProductStateRow {
    const productName = input.productName.trim();
    return {
      id: randomUUID(), userId, profileId,
      productKey: input.productKey?.trim() || productKeyFor(productName), productName,
      journeyStage: input.journeyStage ?? "unknown", sentiment: input.sentiment ?? "unknown",
      satisfaction: input.satisfaction ?? "unknown", health: input.health ?? "healthy",
      needs: input.needs ?? [], objections: input.objections ?? [], currentIssues: input.currentIssues ?? [],
      manualLockFields: input.manualLockFields ?? [],
    };
  }

  private emptyProductState(userId: string, profileId: string, productKey: string, productName: string): CustomerProductState {
    const now = new Date().toISOString();
    return {
      id: randomUUID(), userId, profileId, productKey, productName,
      journeyStage: "unknown", sentiment: "unknown", satisfaction: "unknown", health: "healthy",
      needs: [], objections: [], currentIssues: [], manualLockFields: [], lastObservationId: null,
      lastConfirmedAt: null, version: 1, createdAt: now, updatedAt: now,
    };
  }

  private mergeProfile(current: StoredCustomerProfile, input: UpdateCustomerProfileInput): StoredCustomerProfile {
    return {
      ...current,
      displayName: input.displayName ?? current.displayName,
      aliases: input.aliases ?? current.aliases,
      customerKind: input.customerKind ?? current.customerKind,
      organization: input.organization === undefined ? current.organization : input.organization,
      department: input.department === undefined ? current.department : input.department,
      title: input.title === undefined ? current.title : input.title,
      customerRegion: input.customerRegion === undefined ? current.customerRegion : input.customerRegion,
      contactCiphertext: input.contact === undefined ? current.contactCiphertext : this.sealContact(input.contact),
      source: input.source === undefined ? current.source : input.source,
      relationshipStage: input.relationshipStage ?? current.relationshipStage,
      overallHealth: input.overallHealth ?? current.overallHealth,
      tags: input.tags ?? current.tags,
      customFields: input.customFields ?? current.customFields,
      manualLockFields: input.manualLockFields ?? current.manualLockFields,
    };
  }

  private sealContact(contact: CreateCustomerProfileInput["contact"]): string | null {
    if (!contact || Object.keys(contact).length === 0) return null;
    return this.secretBox.seal(JSON.stringify(contact));
  }

  private publicProfile(profile: StoredCustomerProfile, includeContact: boolean): CustomerProfile {
    const { contactCiphertext, ...safe } = profile;
    return {
      ...safe,
      contact: includeContact ? this.openContact(contactCiphertext) : null,
    };
  }

  private openContact(ciphertext: string | null): CustomerProfile["contact"] {
    if (!ciphertext) return null;
    try {
      const parsed = JSON.parse(this.secretBox.open(ciphertext));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as CustomerProfile["contact"];
    } catch {
      // Treat a malformed legacy value as unavailable instead of exposing a
      // ciphertext / parse error to clients. The rest of the profile remains usable.
      return null;
    }
  }
}

function profileSummaryShape(profile: Pick<CustomerProfile, "displayName" | "relationshipStage" | "overallHealth" | "tags">): Pick<CustomerProfile, "displayName" | "relationshipStage" | "overallHealth" | "tags"> {
  return profile;
}

function profileSummaryInput(input: CreateCustomerProfileInput): Pick<CustomerProfile, "displayName" | "relationshipStage" | "overallHealth" | "tags"> {
  return {
    displayName: input.displayName,
    relationshipStage: input.relationshipStage ?? "lead",
    overallHealth: input.overallHealth ?? "healthy",
    tags: input.tags ?? [],
  };
}

function productSummaryShape(product: Pick<NewProductStateRow, "productName" | "journeyStage" | "satisfaction" | "health" | "currentIssues" | "objections">) {
  return product;
}

function profileStateSnapshot(profile: Pick<CustomerProfile, "relationshipStage" | "overallHealth" | "manualLockFields">): JsonObject {
  return {
    relationshipStage: profile.relationshipStage,
    overallHealth: profile.overallHealth,
    manualLockFields: profile.manualLockFields,
  };
}

function profileStatePatch(before: Pick<CustomerProfile, "relationshipStage" | "overallHealth" | "manualLockFields">, after: Pick<CustomerProfile, "relationshipStage" | "overallHealth" | "manualLockFields">): JsonObject {
  const patch: JsonObject = {};
  if (before.relationshipStage !== after.relationshipStage) patch.relationshipStage = after.relationshipStage;
  if (before.overallHealth !== after.overallHealth) patch.overallHealth = after.overallHealth;
  if (JSON.stringify(before.manualLockFields) !== JSON.stringify(after.manualLockFields)) patch.manualLockFields = after.manualLockFields;
  return patch;
}

function productStateSnapshot(product: Pick<CustomerProductState, "productName" | "journeyStage" | "sentiment" | "satisfaction" | "health" | "needs" | "objections" | "currentIssues" | "manualLockFields">): JsonObject {
  return {
    productName: product.productName,
    journeyStage: product.journeyStage,
    sentiment: product.sentiment,
    satisfaction: product.satisfaction,
    health: product.health,
    needs: product.needs,
    objections: product.objections,
    currentIssues: product.currentIssues,
    manualLockFields: product.manualLockFields,
  };
}

function productStatePatch(before: CustomerProductState, after: CustomerProductState): JsonObject {
  const beforeState = productStateSnapshot(before);
  const afterState = productStateSnapshot(after);
  const patch: JsonObject = {};
  for (const [key, value] of Object.entries(afterState)) {
    if (JSON.stringify(value) !== JSON.stringify(beforeState[key])) patch[key] = value;
  }
  return patch;
}

function compact<T extends object>(value: T): JsonObject {
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function displayCandidate(candidate: { displayName: string; customerRegion?: string | null }): string {
  return candidate.customerRegion ? `${candidate.displayName}（${candidate.customerRegion}）` : candidate.displayName;
}

function sourceIdForDraft(draft: { sourceMessageId: string | null; id: string }, profileId: string): string {
  return `${draft.sourceMessageId ?? draft.id}:${profileId}`;
}

function profileChangePatch(input: ProfileChangeInput): JsonObject {
  const patch: JsonObject = {};
  const fields: Array<keyof Omit<ProfileChangeInput, "operation" | "customerMention">> = [
    "displayName",
    "aliases",
    "customerRegion",
    "source",
    "relationshipStage",
    "overallHealth",
    "tags",
  ];
  for (const field of fields) {
    const value = input[field];
    if (value !== undefined) patch[field] = value;
  }
  return patch;
}

function isContextReference(value: string): boolean {
  return /^(她|他|ta|TA|刚才那位|刚才的客户|这位|这个客户|该客户|上面那位)$/.test(value.trim());
}
