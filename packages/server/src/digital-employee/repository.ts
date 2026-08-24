import type { Pool, PoolClient } from "pg";
import type { QueryClient } from "../db/migration-runner.js";
import type {
  CaptureDraftStatus,
  CustomerCaptureDraft,
  CustomerProfileChangeDraft,
  CustomerObservation,
  CustomerObservationExtraction,
  CustomerProductState,
  CustomerProfile,
  CustomerCohortSnapshot,
  CustomerStateChange,
  ExtractionApplyStatus,
  JsonObject,
  ObservationSourceType,
  ObservationType,
  ProfileListFilters,
  ProfileListResult,
  ProfileChangeDraftStatus,
  ProfileChangeOperation,
  StoredCustomerProfile,
} from "./types.js";

type Client = QueryClient;

export interface NewProfileRow {
  id: string;
  userId: string;
  ownerUserId: string;
  displayName: string;
  aliases: string[];
  customerKind: CustomerProfile["customerKind"];
  organization: string | null;
  department: string | null;
  title: string | null;
  customerRegion: string | null;
  contactCiphertext: string | null;
  source: string | null;
  relationshipStage: CustomerProfile["relationshipStage"];
  overallHealth: CustomerProfile["overallHealth"];
  tags: string[];
  customFields: JsonObject;
  summary: string;
  summaryVersion: number;
  manualLockFields: string[];
  lastObservedAt?: string | null;
  lastContactAt?: string | null;
  nextFollowUpAt?: string | null;
}

export interface NewProductStateRow {
  id: string;
  userId: string;
  profileId: string;
  productKey: string;
  productName: string;
  marketingProductId?: string | null;
  journeyStage: CustomerProductState["journeyStage"];
  sentiment: CustomerProductState["sentiment"];
  satisfaction: CustomerProductState["satisfaction"];
  health: CustomerProductState["health"];
  needs: unknown[];
  objections: unknown[];
  currentIssues: unknown[];
  manualLockFields: string[];
  lastObservationId?: string | null;
  lastConfirmedAt?: string | null;
}

export interface NewObservationRow {
  id: string;
  userId: string;
  profileId: string;
  sourceType: ObservationSourceType;
  sourceId: string;
  sourceLocator: JsonObject;
  rawText: string;
  rawTextHash: string;
  occurredAt?: string | null;
  supersedesId?: string | null;
}

export interface NewExtractionRow {
  id: string;
  userId: string;
  profileId: string;
  observationId: string;
  eventType: ObservationType;
  productKey?: string | null;
  productName?: string | null;
  marketingProductId?: string | null;
  extractedFacts: JsonObject;
  proposedPatch: JsonObject;
  applyStatus: ExtractionApplyStatus;
  confidence?: number | null;
  modelId?: string | null;
  promptVersion: string;
  schemaVersion: string;
  supersedesExtractionId?: string | null;
  appliedAt?: string | null;
}

export interface NewStateChangeRow {
  id: string;
  userId: string;
  profileId: string;
  productStateId?: string | null;
  sourceObservationId?: string | null;
  sourceExtractionId?: string | null;
  actorType: CustomerStateChange["actorType"];
  beforeState: JsonObject;
  patch: JsonObject;
  afterState: JsonObject;
  reason?: string | null;
}

export interface NewDraftRow {
  id: string;
  userId: string;
  conversationId?: string | null;
  sourceMessageId?: string | null;
  rawText: string;
  candidateProfileIds: string[];
  proposedObservation: JsonObject;
  ambiguities: string[];
  status: CaptureDraftStatus;
  expiresAt: string;
}

export interface NewProfileChangeDraftRow {
  id: string;
  userId: string;
  conversationId?: string | null;
  sourceMessageId?: string | null;
  operation: ProfileChangeOperation;
  customerMention?: string | null;
  candidateProfileIds: string[];
  proposedPatch: JsonObject;
  targetVersion?: number | null;
  risks: string[];
  status: ProfileChangeDraftStatus;
  expiresAt: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export interface StoredProfileListResult extends Omit<ProfileListResult, "items"> {
  items: StoredCustomerProfile[];
}

/**
 * PostgreSQL-only persistence boundary for the customer-profile domain.
 * Every public lookup requires a userId, making cross-user access impossible
 * to accidentally introduce through a convenient object-id-only helper.
 */
export class DigitalEmployeeRepository {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listProfiles(userId: string, filters: ProfileListFilters): Promise<StoredProfileListResult> {
    const where: string[] = ["user_id = $1", "status = $2"];
    const params: unknown[] = [userId, filters.status ?? "active"];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filters.query) {
      const placeholder = add(`%${filters.query}%`);
      where.push(
        `(display_name ILIKE ${placeholder} OR EXISTS (SELECT 1 FROM unnest(aliases) AS profile_alias WHERE profile_alias ILIKE ${placeholder}))`
      );
    }
    if (filters.relationshipStage) where.push(`relationship_stage = ${add(filters.relationshipStage)}`);
    if (filters.health) where.push(`overall_health = ${add(filters.health)}`);
    if (filters.tag) where.push(`${add(filters.tag)} = ANY(tags)`);
    const whereSql = where.join(" AND ");
    const count = await this.pool.query(`SELECT count(*)::int AS total FROM de_customer_profiles WHERE ${whereSql}`, params);
    const limit = Math.min(Math.max(filters.limit, 1), 100);
    const offset = (filters.page - 1) * limit;
    const rows = await this.pool.query(
      `SELECT * FROM de_customer_profiles
       WHERE ${whereSql}
       ORDER BY updated_at DESC, id DESC
       LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params
    );
    return {
      items: rows.rows.map(toProfile),
      page: filters.page,
      limit,
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async listActiveProfilesForCohort(userId: string): Promise<StoredCustomerProfile[]> {
    const result = await this.pool.query(
      `SELECT * FROM de_customer_profiles
       WHERE user_id = $1 AND status = 'active'
       ORDER BY updated_at DESC, id DESC`,
      [userId]
    );
    return result.rows.map(toProfile);
  }

  async listUsersMissingCohortSnapshot(snapshotDate: string): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT profile.user_id
       FROM de_customer_profiles profile
       LEFT JOIN de_customer_cohort_snapshots snapshot
         ON snapshot.user_id = profile.user_id
        AND snapshot.snapshot_date = $1::date
       WHERE profile.status = 'active' AND snapshot.user_id IS NULL
       ORDER BY profile.user_id`,
      [snapshotDate]
    );
    return result.rows.map((row) => String(row.user_id));
  }

  async getLatestCohortSnapshot(userId: string): Promise<CustomerCohortSnapshot | null> {
    const result = await this.pool.query(
      `SELECT snapshot_date, summary, metrics, generated_at, generation_method, model_id
       FROM de_customer_cohort_snapshots
       WHERE user_id = $1
       ORDER BY snapshot_date DESC
       LIMIT 1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      snapshotDate: dateOnly(row.snapshot_date),
      summary: String(row.summary),
      metrics: row.metrics,
      generatedAt: toIso(row.generated_at),
      generationMethod: row.generation_method === "llm" ? "llm" : "logic",
      modelId: nullableText(row.model_id),
    } as CustomerCohortSnapshot;
  }

  async upsertCohortSnapshot(userId: string, snapshot: CustomerCohortSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO de_customer_cohort_snapshots (
         user_id, snapshot_date, summary, metrics, generated_at,
         generation_method, model_id, fallback_reason
       ) VALUES ($1, $2::date, $3, $4::jsonb, $5::timestamptz, $6, $7, $8)
       ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
         summary = EXCLUDED.summary,
         metrics = EXCLUDED.metrics,
         generated_at = EXCLUDED.generated_at,
         generation_method = EXCLUDED.generation_method,
         model_id = EXCLUDED.model_id,
         fallback_reason = EXCLUDED.fallback_reason`,
      [
        userId,
        snapshot.snapshotDate,
        snapshot.summary,
        JSON.stringify(snapshot.metrics),
        snapshot.generatedAt,
        snapshot.generationMethod,
        snapshot.modelId,
        snapshot.generationMethod === "logic" ? "llm_unavailable_or_failed" : null,
      ]
    );
  }

  async getProfile(userId: string, profileId: string, client: Client = this.pool): Promise<StoredCustomerProfile | null> {
    const result = await client.query(
      "SELECT * FROM de_customer_profiles WHERE id = $1 AND user_id = $2",
      [profileId, userId]
    );
    return result.rows[0] ? toProfile(result.rows[0]) : null;
  }

  async findProfilesByExactMention(userId: string, mention: string): Promise<StoredCustomerProfile[]> {
    const result = await this.pool.query(
      `SELECT * FROM de_customer_profiles
       WHERE user_id = $1
         AND status = 'active'
         AND (lower(display_name) = lower($2)
              OR EXISTS (SELECT 1 FROM unnest(aliases) AS profile_alias WHERE lower(profile_alias) = lower($2)))
       ORDER BY updated_at DESC, id DESC
       LIMIT 6`,
      [userId, mention]
    );
    return result.rows.map(toProfile);
  }

  async createProfile(row: NewProfileRow, client: Client = this.pool): Promise<StoredCustomerProfile> {
    const result = await client.query(
      `INSERT INTO de_customer_profiles (
        id, user_id, owner_user_id, display_name, aliases, customer_kind,
        organization, department, title, customer_region, contact_ciphertext, source,
        relationship_stage, overall_health, tags, custom_fields, summary,
        summary_version, manual_lock_fields, last_observed_at, last_contact_at, next_follow_up_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
      ) RETURNING *`,
      [
        row.id, row.userId, row.ownerUserId, row.displayName, row.aliases, row.customerKind,
        row.organization, row.department, row.title, row.customerRegion, row.contactCiphertext, row.source,
        row.relationshipStage, row.overallHealth, row.tags, jsonParam(row.customFields), row.summary,
        row.summaryVersion, row.manualLockFields, row.lastObservedAt ?? null, row.lastContactAt ?? null,
        row.nextFollowUpAt ?? null,
      ]
    );
    return toProfile(result.rows[0]);
  }

  /** Saves the full mutable profile row under an optimistic lock. */
  async saveProfile(
    userId: string,
    row: StoredCustomerProfile,
    expectedVersion: number,
    client: Client = this.pool
  ): Promise<StoredCustomerProfile | null> {
    const result = await client.query(
      `UPDATE de_customer_profiles
       SET display_name = $1, aliases = $2, customer_kind = $3,
           organization = $4, department = $5, title = $6, customer_region = $7,
           contact_ciphertext = $8, source = $9, relationship_stage = $10,
           overall_health = $11, tags = $12, custom_fields = $13, summary = $14,
           summary_version = $15, manual_lock_fields = $16, last_observed_at = $17,
           last_contact_at = $18, next_follow_up_at = $19,
           version = version + 1, updated_at = now()
       WHERE id = $20 AND user_id = $21 AND version = $22 AND status = 'active'
       RETURNING *`,
      [
        row.displayName, row.aliases, row.customerKind, row.organization, row.department,
        row.title, row.customerRegion, row.contactCiphertext, row.source, row.relationshipStage,
        row.overallHealth, row.tags, jsonParam(row.customFields), row.summary, row.summaryVersion,
        row.manualLockFields, row.lastObservedAt, row.lastContactAt, row.nextFollowUpAt,
        row.id, userId, expectedVersion,
      ]
    );
    return result.rows[0] ? toProfile(result.rows[0]) : null;
  }

  async archiveProfile(userId: string, profileId: string, version: number, client: Client = this.pool): Promise<StoredCustomerProfile | null> {
    const result = await client.query(
      `UPDATE de_customer_profiles
       SET status = 'archived', archived_at = now(), version = version + 1, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'active' AND version = $3
       RETURNING *`,
      [profileId, userId, version]
    );
    return result.rows[0] ? toProfile(result.rows[0]) : null;
  }

  async listProductStates(userId: string, profileId: string, client: Client = this.pool): Promise<CustomerProductState[]> {
    const result = await client.query(
      `SELECT state.*, product.name AS marketing_product_name
       FROM de_customer_product_states state
       LEFT JOIN marketing_products product ON product.id = state.marketing_product_id
       WHERE state.user_id = $1 AND state.profile_id = $2
       ORDER BY state.updated_at DESC, state.product_name ASC`,
      [userId, profileId]
    );
    return result.rows.map(toProductState);
  }

  async getProductState(
    userId: string,
    profileId: string,
    productKey: string,
    client: Client = this.pool
  ): Promise<CustomerProductState | null> {
    const result = await client.query(
      `SELECT state.*, product.name AS marketing_product_name
       FROM de_customer_product_states state
       LEFT JOIN marketing_products product ON product.id = state.marketing_product_id
       WHERE state.user_id = $1 AND state.profile_id = $2 AND state.product_key = $3`,
      [userId, profileId, productKey]
    );
    return result.rows[0] ? toProductState(result.rows[0]) : null;
  }

  async getProductStateByMarketingProduct(
    userId: string,
    profileId: string,
    marketingProductId: string,
    client: Client = this.pool
  ): Promise<CustomerProductState | null> {
    const result = await client.query(
      `SELECT state.*, product.name AS marketing_product_name
       FROM de_customer_product_states state
       LEFT JOIN marketing_products product ON product.id = state.marketing_product_id
       WHERE state.user_id = $1 AND state.profile_id = $2 AND state.marketing_product_id = $3
       ORDER BY state.updated_at DESC LIMIT 1`,
      [userId, profileId, marketingProductId]
    );
    return result.rows[0] ? toProductState(result.rows[0]) : null;
  }

  async createProductState(row: NewProductStateRow, client: Client = this.pool): Promise<CustomerProductState> {
    const result = await client.query(
      `INSERT INTO de_customer_product_states (
        id, user_id, profile_id, product_key, product_name, marketing_product_id, journey_stage,
        sentiment, satisfaction, health, needs, objections, current_issues,
        manual_lock_fields, last_observation_id, last_confirmed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        row.id, row.userId, row.profileId, row.productKey, row.productName, row.marketingProductId ?? null, row.journeyStage,
        row.sentiment, row.satisfaction, row.health, jsonParam(row.needs), jsonParam(row.objections), jsonParam(row.currentIssues),
        row.manualLockFields, row.lastObservationId ?? null, row.lastConfirmedAt ?? null,
      ]
    );
    return toProductState(result.rows[0]);
  }

  async saveProductState(
    userId: string,
    row: CustomerProductState,
    expectedVersion: number,
    client: Client = this.pool
  ): Promise<CustomerProductState | null> {
    const result = await client.query(
      `UPDATE de_customer_product_states
       SET product_name = $1, marketing_product_id = $2, journey_stage = $3, sentiment = $4, satisfaction = $5,
           health = $6, needs = $7, objections = $8, current_issues = $9,
           manual_lock_fields = $10, last_observation_id = $11, last_confirmed_at = $12,
           version = version + 1, updated_at = now()
       WHERE id = $13 AND user_id = $14 AND version = $15
       RETURNING *`,
      [
        row.productName, row.marketingProductId, row.journeyStage, row.sentiment, row.satisfaction, row.health,
        jsonParam(row.needs), jsonParam(row.objections), jsonParam(row.currentIssues), row.manualLockFields,
        row.lastObservationId, row.lastConfirmedAt, row.id, userId, expectedVersion,
      ]
    );
    return result.rows[0] ? toProductState(result.rows[0]) : null;
  }

  async createObservation(row: NewObservationRow, client: Client = this.pool): Promise<CustomerObservation | null> {
    const result = await client.query(
      `INSERT INTO de_customer_observations (
        id, user_id, profile_id, source_type, source_id, source_locator,
        raw_text, raw_text_hash, occurred_at, supersedes_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (user_id, source_type, source_id) DO NOTHING
      RETURNING *`,
      [
        row.id, row.userId, row.profileId, row.sourceType, row.sourceId, jsonParam(row.sourceLocator),
        row.rawText, row.rawTextHash, row.occurredAt ?? null, row.supersedesId ?? null,
      ]
    );
    return result.rows[0] ? toObservation(result.rows[0]) : null;
  }

  async getObservationBySource(
    userId: string,
    sourceType: ObservationSourceType,
    sourceId: string,
    client: Client = this.pool
  ): Promise<CustomerObservation | null> {
    const result = await client.query(
      `SELECT * FROM de_customer_observations
       WHERE user_id = $1 AND source_type = $2 AND source_id = $3`,
      [userId, sourceType, sourceId]
    );
    return result.rows[0] ? toObservation(result.rows[0]) : null;
  }

  async listObservations(userId: string, profileId: string, page: number, limit: number): Promise<Page<CustomerObservation>> {
    const offset = (page - 1) * limit;
    const [count, rows] = await Promise.all([
      this.pool.query(
        "SELECT count(*)::int AS total FROM de_customer_observations WHERE user_id = $1 AND profile_id = $2",
        [userId, profileId]
      ),
      this.pool.query(
        `SELECT * FROM de_customer_observations
         WHERE user_id = $1 AND profile_id = $2
         ORDER BY coalesce(occurred_at, created_at) DESC, id DESC
         LIMIT $3 OFFSET $4`,
        [userId, profileId, limit, offset]
      ),
    ]);
    return { items: rows.rows.map(toObservation), page, limit, total: Number(count.rows[0]?.total ?? 0) };
  }

  async createExtraction(row: NewExtractionRow, client: Client = this.pool): Promise<CustomerObservationExtraction> {
    const result = await client.query(
      `INSERT INTO de_customer_observation_extractions (
        id, user_id, profile_id, observation_id, event_type, product_key, product_name, marketing_product_id,
        extracted_facts, proposed_patch, apply_status, confidence, model_id,
        prompt_version, schema_version, supersedes_extraction_id, applied_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *`,
      [
        row.id, row.userId, row.profileId, row.observationId, row.eventType,
        row.productKey ?? null, row.productName ?? null, row.marketingProductId ?? null,
        jsonParam(row.extractedFacts), jsonParam(row.proposedPatch),
        row.applyStatus, row.confidence ?? null, row.modelId ?? null, row.promptVersion,
        row.schemaVersion, row.supersedesExtractionId ?? null, row.appliedAt ?? null,
      ]
    );
    return toExtraction(result.rows[0]);
  }

  async getLatestExtractionForObservation(
    userId: string,
    observationId: string,
    client: Client = this.pool
  ): Promise<CustomerObservationExtraction | null> {
    const result = await client.query(
      `SELECT * FROM de_customer_observation_extractions
       WHERE user_id = $1 AND observation_id = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId, observationId]
    );
    return result.rows[0] ? toExtraction(result.rows[0]) : null;
  }

  async createStateChange(row: NewStateChangeRow, client: Client = this.pool): Promise<CustomerStateChange> {
    const result = await client.query(
      `INSERT INTO de_customer_state_changes (
        id, user_id, profile_id, product_state_id, source_observation_id,
        source_extraction_id, actor_type, before_state, patch, after_state, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        row.id, row.userId, row.profileId, row.productStateId ?? null,
        row.sourceObservationId ?? null, row.sourceExtractionId ?? null, row.actorType,
        jsonParam(row.beforeState), jsonParam(row.patch), jsonParam(row.afterState), row.reason ?? null,
      ]
    );
    return toStateChange(result.rows[0]);
  }

  async listStateChanges(userId: string, profileId: string, page: number, limit: number): Promise<Page<CustomerStateChange>> {
    const offset = (page - 1) * limit;
    const [count, rows] = await Promise.all([
      this.pool.query(
        "SELECT count(*)::int AS total FROM de_customer_state_changes WHERE user_id = $1 AND profile_id = $2",
        [userId, profileId]
      ),
      this.pool.query(
        `SELECT * FROM de_customer_state_changes
         WHERE user_id = $1 AND profile_id = $2
         ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [userId, profileId, limit, offset]
      ),
    ]);
    return { items: rows.rows.map(toStateChange), page, limit, total: Number(count.rows[0]?.total ?? 0) };
  }

  async createDraft(row: NewDraftRow, client: Client = this.pool): Promise<CustomerCaptureDraft> {
    const result = await client.query(
      `INSERT INTO de_customer_capture_drafts (
        id, user_id, conversation_id, source_message_id, raw_text,
        candidate_profile_ids, proposed_observation, ambiguities, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        row.id, row.userId, row.conversationId ?? null, row.sourceMessageId ?? null, row.rawText,
        jsonParam(row.candidateProfileIds), jsonParam(row.proposedObservation), jsonParam(row.ambiguities), row.status, row.expiresAt,
      ]
    );
    return toDraft(result.rows[0]);
  }

  async getDraft(userId: string, draftId: string, client: Client = this.pool, forUpdate = false): Promise<CustomerCaptureDraft | null> {
    const result = await client.query(
      `SELECT * FROM de_customer_capture_drafts
       WHERE id = $1 AND user_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [draftId, userId]
    );
    return result.rows[0] ? toDraft(result.rows[0]) : null;
  }

  async markDraftApplied(
    userId: string,
    draftId: string,
    profileId: string,
    observationId: string,
    client: Client = this.pool
  ): Promise<CustomerCaptureDraft | null> {
    const result = await client.query(
      `UPDATE de_customer_capture_drafts
       SET status = 'applied', applied_profile_id = $1, applied_observation_id = $2, updated_at = now()
       WHERE id = $3 AND user_id = $4 AND status IN ('prepared', 'awaiting_confirmation')
       RETURNING *`,
      [profileId, observationId, draftId, userId]
    );
    return result.rows[0] ? toDraft(result.rows[0]) : null;
  }

  async createProfileChangeDraft(
    row: NewProfileChangeDraftRow,
    client: Client = this.pool
  ): Promise<CustomerProfileChangeDraft> {
    const result = await client.query(
      `INSERT INTO de_customer_profile_change_drafts (
        id, user_id, conversation_id, source_message_id, operation, customer_mention,
        candidate_profile_ids, proposed_patch, target_version, risks, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (user_id, source_message_id, operation) WHERE source_message_id IS NOT NULL
      DO UPDATE SET updated_at = de_customer_profile_change_drafts.updated_at
      RETURNING *`,
      [
        row.id, row.userId, row.conversationId ?? null, row.sourceMessageId ?? null,
        row.operation, row.customerMention ?? null, jsonParam(row.candidateProfileIds),
        jsonParam(row.proposedPatch), row.targetVersion ?? null, row.risks, row.status, row.expiresAt,
      ]
    );
    return toProfileChangeDraft(result.rows[0]);
  }

  async getProfileChangeDraft(
    userId: string,
    draftId: string,
    client: Client = this.pool,
    forUpdate = false
  ): Promise<CustomerProfileChangeDraft | null> {
    const result = await client.query(
      `SELECT * FROM de_customer_profile_change_drafts
       WHERE id = $1 AND user_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [draftId, userId]
    );
    return result.rows[0] ? toProfileChangeDraft(result.rows[0]) : null;
  }

  async markProfileChangeDraftApplied(
    userId: string,
    draftId: string,
    profileId: string,
    client: Client = this.pool
  ): Promise<CustomerProfileChangeDraft | null> {
    const result = await client.query(
      `UPDATE de_customer_profile_change_drafts
       SET status = 'applied', applied_profile_id = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3 AND status IN ('prepared', 'awaiting_confirmation')
       RETURNING *`,
      [profileId, draftId, userId]
    );
    return result.rows[0] ? toProfileChangeDraft(result.rows[0]) : null;
  }
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/** node-postgres encodes JavaScript arrays as PostgreSQL arrays (`{...}`).
 * JSONB columns must receive explicit JSON text instead. Applying this to
 * objects too keeps every JSONB write deterministic and driver-independent. */
function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function jsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
    } catch {
      return {};
    }
  }
  return {};
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function time(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function requiredTime(value: unknown): string {
  return time(value) ?? new Date(0).toISOString();
}

function toIso(value: unknown): string {
  return requiredTime(value);
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toProfile(row: Record<string, unknown>): StoredCustomerProfile {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    ownerUserId: String(row.owner_user_id ?? row.user_id),
    displayName: String(row.display_name),
    aliases: textArray(row.aliases),
    customerKind: String(row.customer_kind ?? "person") as CustomerProfile["customerKind"],
    organization: nullableText(row.organization),
    department: nullableText(row.department),
    title: nullableText(row.title),
    customerRegion: nullableText(row.customer_region),
    contactCiphertext: nullableText(row.contact_ciphertext),
    source: nullableText(row.source),
    relationshipStage: String(row.relationship_stage ?? "lead") as CustomerProfile["relationshipStage"],
    overallHealth: String(row.overall_health ?? "healthy") as CustomerProfile["overallHealth"],
    tags: textArray(row.tags),
    customFields: jsonObject(row.custom_fields),
    summary: String(row.summary ?? ""),
    summaryVersion: number(row.summary_version, 1),
    manualLockFields: textArray(row.manual_lock_fields),
    lastObservedAt: time(row.last_observed_at),
    lastContactAt: time(row.last_contact_at),
    nextFollowUpAt: time(row.next_follow_up_at),
    version: number(row.version, 1),
    status: String(row.status ?? "active") as CustomerProfile["status"],
    archivedAt: time(row.archived_at),
    createdAt: requiredTime(row.created_at),
    updatedAt: requiredTime(row.updated_at),
  };
}

function toProductState(row: Record<string, unknown>): CustomerProductState {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    profileId: String(row.profile_id),
    productKey: String(row.product_key),
    productName: String(row.marketing_product_name ?? row.product_name),
    marketingProductId: nullableText(row.marketing_product_id),
    journeyStage: String(row.journey_stage ?? "unknown") as CustomerProductState["journeyStage"],
    sentiment: String(row.sentiment ?? "unknown") as CustomerProductState["sentiment"],
    satisfaction: String(row.satisfaction ?? "unknown") as CustomerProductState["satisfaction"],
    health: String(row.health ?? "healthy") as CustomerProductState["health"],
    needs: jsonArray(row.needs),
    objections: jsonArray(row.objections),
    currentIssues: jsonArray(row.current_issues),
    manualLockFields: textArray(row.manual_lock_fields),
    lastObservationId: nullableText(row.last_observation_id),
    lastConfirmedAt: time(row.last_confirmed_at),
    version: number(row.version, 1),
    createdAt: requiredTime(row.created_at),
    updatedAt: requiredTime(row.updated_at),
  };
}

function toObservation(row: Record<string, unknown>): CustomerObservation {
  return {
    id: String(row.id), userId: String(row.user_id), profileId: String(row.profile_id),
    sourceType: String(row.source_type) as ObservationSourceType,
    sourceId: String(row.source_id), sourceLocator: jsonObject(row.source_locator),
    rawText: String(row.raw_text), rawTextHash: String(row.raw_text_hash),
    occurredAt: time(row.occurred_at), supersedesId: nullableText(row.supersedes_id),
    createdAt: requiredTime(row.created_at),
  };
}

function toExtraction(row: Record<string, unknown>): CustomerObservationExtraction {
  return {
    id: String(row.id), userId: String(row.user_id), profileId: String(row.profile_id),
    observationId: String(row.observation_id), eventType: String(row.event_type) as ObservationType,
    productKey: nullableText(row.product_key), productName: nullableText(row.product_name),
    marketingProductId: nullableText(row.marketing_product_id),
    extractedFacts: jsonObject(row.extracted_facts), proposedPatch: jsonObject(row.proposed_patch),
    applyStatus: String(row.apply_status) as ExtractionApplyStatus,
    confidence: row.confidence == null ? null : number(row.confidence), modelId: nullableText(row.model_id),
    promptVersion: String(row.prompt_version), schemaVersion: String(row.schema_version),
    supersedesExtractionId: nullableText(row.supersedes_extraction_id),
    createdAt: requiredTime(row.created_at), appliedAt: time(row.applied_at),
  };
}

function toStateChange(row: Record<string, unknown>): CustomerStateChange {
  return {
    id: String(row.id), userId: String(row.user_id), profileId: String(row.profile_id),
    productStateId: nullableText(row.product_state_id), sourceObservationId: nullableText(row.source_observation_id),
    sourceExtractionId: nullableText(row.source_extraction_id),
    actorType: String(row.actor_type) as CustomerStateChange["actorType"],
    beforeState: jsonObject(row.before_state), patch: jsonObject(row.patch), afterState: jsonObject(row.after_state),
    reason: nullableText(row.reason), createdAt: requiredTime(row.created_at),
  };
}

function toDraft(row: Record<string, unknown>): CustomerCaptureDraft {
  return {
    id: String(row.id), userId: String(row.user_id), conversationId: nullableText(row.conversation_id),
    sourceMessageId: nullableText(row.source_message_id), rawText: String(row.raw_text),
    candidateProfileIds: textArray(row.candidate_profile_ids), proposedObservation: jsonObject(row.proposed_observation),
    ambiguities: textArray(row.ambiguities), status: String(row.status) as CaptureDraftStatus,
    appliedProfileId: nullableText(row.applied_profile_id), appliedObservationId: nullableText(row.applied_observation_id),
    expiresAt: requiredTime(row.expires_at), createdAt: requiredTime(row.created_at), updatedAt: requiredTime(row.updated_at),
  };
}

function toProfileChangeDraft(row: Record<string, unknown>): CustomerProfileChangeDraft {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: nullableText(row.conversation_id),
    sourceMessageId: nullableText(row.source_message_id),
    operation: String(row.operation) as ProfileChangeOperation,
    customerMention: nullableText(row.customer_mention),
    candidateProfileIds: textArray(row.candidate_profile_ids),
    proposedPatch: jsonObject(row.proposed_patch),
    targetVersion: row.target_version == null ? null : number(row.target_version),
    risks: textArray(row.risks),
    status: String(row.status) as ProfileChangeDraftStatus,
    appliedProfileId: nullableText(row.applied_profile_id),
    expiresAt: requiredTime(row.expires_at),
    createdAt: requiredTime(row.created_at),
    updatedAt: requiredTime(row.updated_at),
  };
}
