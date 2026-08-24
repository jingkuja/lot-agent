import {
  CUSTOMER_KINDS,
  HEALTH_VALUES,
  JOURNEY_STAGES,
  OBSERVATION_TYPES,
  RELATIONSHIP_STAGES,
  SATISFACTION_VALUES,
  SENTIMENT_VALUES,
  type AddManualObservationInput,
  type CreateCustomerProfileInput,
  type CreateProductStateInput,
  type CustomerCaptureInput,
  type CustomerContact,
  type CustomerKind,
  type Health,
  type JourneyStage,
  type JsonObject,
  type ObservationFacts,
  type ObservationType,
  type ProfileListFilters,
  type RelationshipStage,
  type Satisfaction,
  type Sentiment,
  type UpdateCustomerProfileInput,
  type UpdateProductStateInput,
} from "./types.js";
import { InputError } from "./errors.js";

const MAX_CUSTOM_FIELDS = 40;
const MAX_JSON_DEPTH = 5;
const MAX_JSON_ITEMS = 80;

function record(value: unknown, label = "请求体"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  max: number,
  opts: { nullable?: boolean; trim?: boolean } = {}
): string | null | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (value === null && opts.nullable) return null;
  if (typeof value !== "string") throw new InputError(`${key}必须是文本`);
  const output = opts.trim === false ? value : value.trim();
  if (output.length > max) throw new InputError(`${key}不能超过${max}个字符`);
  return output;
}

function requiredString(source: Record<string, unknown>, key: string, max: number): string {
  const value = optionalString(source, key, max);
  if (!value) throw new InputError(`${key}不能为空`);
  return value;
}

function enumValue<T extends readonly string[]>(
  source: Record<string, unknown>,
  key: string,
  choices: T
): T[number] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new InputError(`${key}取值无效`);
  }
  return value as T[number];
}

function requiredEnum<T extends readonly string[]>(
  source: Record<string, unknown>,
  key: string,
  choices: T
): T[number] {
  const value = enumValue(source, key, choices);
  if (value === undefined) throw new InputError(`${key}不能为空`);
  return value;
}

function positiveInt(value: unknown, label: string, opts: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < opts.min || value > opts.max) {
    throw new InputError(`${label}必须是${opts.min}到${opts.max}之间的整数`);
  }
  return value;
}

function stringArray(
  value: unknown,
  key: string,
  opts: { maxItems: number; maxLength: number } = { maxItems: 30, maxLength: 100 }
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > opts.maxItems) {
    throw new InputError(`${key}格式无效`);
  }
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new InputError(`${key}只能包含文本`);
    const normalized = item.trim();
    if (!normalized || normalized.length > opts.maxLength) throw new InputError(`${key}包含无效内容`);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output;
}

function jsonValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 2_000) throw new InputError("自定义字段文本过长");
    if (typeof value === "number" && !Number.isFinite(value)) throw new InputError("自定义字段数值无效");
    return value;
  }
  if (depth >= MAX_JSON_DEPTH) throw new InputError("自定义字段嵌套层级过深");
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ITEMS) throw new InputError("自定义字段数组过长");
    return value.map((item) => jsonValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const entries = Object.entries(source);
    if (entries.length > MAX_CUSTOM_FIELDS) throw new InputError("自定义字段数量过多");
    const out: JsonObject = {};
    for (const [key, item] of entries) {
      if (!key || key.length > 100) throw new InputError("自定义字段名无效");
      out[key] = jsonValue(item, depth + 1);
    }
    return out;
  }
  throw new InputError("自定义字段格式无效");
}

function jsonObject(value: unknown, key: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(`${key}必须是对象`);
  return jsonValue(value) as JsonObject;
}

function jsonArray(value: unknown, key: string): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InputError(`${key}必须是数组`);
  return jsonValue(value) as unknown[];
}

function contact(value: unknown): CustomerContact | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const source = record(value, "contact");
  const out: CustomerContact = {};
  for (const key of ["phone", "email", "wechat", "address", "other"] as const) {
    const item = optionalString(source, key, key === "address" || key === "other" ? 500 : 200);
    if (item) out[key] = item;
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

function isoDate(value: unknown, key: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new InputError(`${key}必须是ISO 8601时间`);
  }
  return new Date(value).toISOString();
}

function facts(value: unknown): ObservationFacts | undefined {
  if (value === undefined) return undefined;
  const source = record(value, "facts");
  return {
    sentiment: enumValue(source, "sentiment", SENTIMENT_VALUES) as Sentiment | undefined,
    satisfaction: enumValue(source, "satisfaction", SATISFACTION_VALUES) as Satisfaction | undefined,
    health: enumValue(source, "health", HEALTH_VALUES) as Health | undefined,
    relationshipStage: enumValue(source, "relationshipStage", RELATIONSHIP_STAGES) as RelationshipStage | undefined,
    journeyStage: enumValue(source, "journeyStage", JOURNEY_STAGES) as JourneyStage | undefined,
    needs: jsonArray(source.needs, "needs"),
    objections: jsonArray(source.objections, "objections"),
    currentIssues: jsonArray(source.currentIssues, "currentIssues"),
  };
}

function productState(value: unknown): CreateProductStateInput {
  const source = record(value, "productStates项");
  const productName = requiredString(source, "productName", 200);
  const productKey = optionalString(source, "productKey", 160);
  const marketingProductId = source.marketingProductId === undefined
    ? undefined
    : parseEntityId(source.marketingProductId, "marketingProductId");
  return {
    productName,
    ...(productKey ? { productKey } : {}),
    ...(marketingProductId ? { marketingProductId } : {}),
    journeyStage: enumValue(source, "journeyStage", JOURNEY_STAGES) as JourneyStage | undefined,
    sentiment: enumValue(source, "sentiment", SENTIMENT_VALUES) as Sentiment | undefined,
    satisfaction: enumValue(source, "satisfaction", SATISFACTION_VALUES) as Satisfaction | undefined,
    health: enumValue(source, "health", HEALTH_VALUES) as Health | undefined,
    needs: jsonArray(source.needs, "needs"),
    objections: jsonArray(source.objections, "objections"),
    currentIssues: jsonArray(source.currentIssues, "currentIssues"),
    manualLockFields: stringArray(source.manualLockFields, "manualLockFields", { maxItems: 16, maxLength: 60 }),
  };
}

export function parseCreateProfile(value: unknown): CreateCustomerProfileInput {
  const source = record(value);
  const products = source.productStates;
  if (products !== undefined && (!Array.isArray(products) || products.length > 20)) {
    throw new InputError("productStates格式无效");
  }
  return {
    displayName: requiredString(source, "displayName", 200),
    aliases: stringArray(source.aliases, "aliases", { maxItems: 20, maxLength: 100 }),
    customerKind: enumValue(source, "customerKind", CUSTOMER_KINDS) as CustomerKind | undefined,
    organization: optionalString(source, "organization", 200, { nullable: true }),
    department: optionalString(source, "department", 200, { nullable: true }),
    title: optionalString(source, "title", 200, { nullable: true }),
    customerRegion: optionalString(source, "customerRegion", 500, { nullable: true }),
    contact: contact(source.contact),
    source: optionalString(source, "source", 64, { nullable: true }),
    relationshipStage: enumValue(source, "relationshipStage", RELATIONSHIP_STAGES) as RelationshipStage | undefined,
    overallHealth: enumValue(source, "overallHealth", HEALTH_VALUES) as Health | undefined,
    tags: stringArray(source.tags, "tags", { maxItems: 30, maxLength: 48 }),
    customFields: jsonObject(source.customFields, "customFields"),
    manualLockFields: stringArray(source.manualLockFields, "manualLockFields", { maxItems: 20, maxLength: 60 }),
    productStates: products?.map(productState),
  };
}

export function parseUpdateProfile(value: unknown): UpdateCustomerProfileInput {
  const source = record(value);
  const version = positiveInt(source.version, "version", { min: 1, max: 2_147_483_647 });
  const displayName = optionalString(source, "displayName", 200);
  if (displayName !== undefined && !displayName) throw new InputError("displayName不能为空");
  return {
    version,
    displayName: displayName || undefined,
    aliases: stringArray(source.aliases, "aliases", { maxItems: 20, maxLength: 100 }),
    customerKind: enumValue(source, "customerKind", CUSTOMER_KINDS) as CustomerKind | undefined,
    organization: optionalString(source, "organization", 200, { nullable: true }),
    department: optionalString(source, "department", 200, { nullable: true }),
    title: optionalString(source, "title", 200, { nullable: true }),
    customerRegion: optionalString(source, "customerRegion", 500, { nullable: true }),
    contact: contact(source.contact),
    source: optionalString(source, "source", 64, { nullable: true }),
    relationshipStage: enumValue(source, "relationshipStage", RELATIONSHIP_STAGES) as RelationshipStage | undefined,
    overallHealth: enumValue(source, "overallHealth", HEALTH_VALUES) as Health | undefined,
    tags: stringArray(source.tags, "tags", { maxItems: 30, maxLength: 48 }),
    customFields: jsonObject(source.customFields, "customFields"),
    manualLockFields: stringArray(source.manualLockFields, "manualLockFields", { maxItems: 20, maxLength: 60 }),
  };
}

export function parseUpdateProductState(value: unknown): UpdateProductStateInput {
  const source = record(value);
  const version = source.version === undefined
    ? undefined
    : positiveInt(source.version, "version", { min: 1, max: 2_147_483_647 });
  const productName = optionalString(source, "productName", 200);
  if (productName !== undefined && !productName) throw new InputError("productName不能为空");
  return {
    version,
    productName: productName || undefined,
    marketingProductId: source.marketingProductId === undefined
      ? undefined
      : parseEntityId(source.marketingProductId, "marketingProductId"),
    journeyStage: enumValue(source, "journeyStage", JOURNEY_STAGES) as JourneyStage | undefined,
    sentiment: enumValue(source, "sentiment", SENTIMENT_VALUES) as Sentiment | undefined,
    satisfaction: enumValue(source, "satisfaction", SATISFACTION_VALUES) as Satisfaction | undefined,
    health: enumValue(source, "health", HEALTH_VALUES) as Health | undefined,
    needs: jsonArray(source.needs, "needs"),
    objections: jsonArray(source.objections, "objections"),
    currentIssues: jsonArray(source.currentIssues, "currentIssues"),
    manualLockFields: stringArray(source.manualLockFields, "manualLockFields", { maxItems: 16, maxLength: 60 }),
  };
}

export function parseProfileList(query: Record<string, string | undefined>): ProfileListFilters {
  const pageRaw = query.page === undefined ? 1 : Number(query.page);
  const limitRaw = query.limit === undefined ? 20 : Number(query.limit);
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 100_000 ? pageRaw : 1;
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 20;
  const enumQuery = <T extends readonly string[]>(key: string, values: T): T[number] | undefined => {
    const input = query[key];
    if (input === undefined || input === "") return undefined;
    if (!values.includes(input)) throw new InputError(`${key}取值无效`);
    return input as T[number];
  };
  const trim = (key: string, max: number) => {
    const input = query[key]?.trim();
    if (!input) return undefined;
    if (input.length > max) throw new InputError(`${key}过长`);
    return input;
  };
  const statusInput = query.status;
  if (statusInput !== undefined && statusInput !== "" && statusInput !== "active" && statusInput !== "archived") {
    throw new InputError("status取值无效");
  }
  return {
    page,
    limit,
    query: trim("q", 200),
    relationshipStage: enumQuery("relationshipStage", RELATIONSHIP_STAGES) as RelationshipStage | undefined,
    health: enumQuery("health", HEALTH_VALUES) as Health | undefined,
    tag: trim("tag", 48),
    status: (statusInput || undefined) as ProfileListFilters["status"],
  };
}

export function parseCaptureInput(value: unknown): CustomerCaptureInput {
  const source = record(value);
  const uncertainties = stringArray(source.uncertainties, "uncertainties", { maxItems: 8, maxLength: 80 });
  const confidenceRaw = source.confidence;
  if (confidenceRaw !== undefined && (typeof confidenceRaw !== "number" || confidenceRaw < 0 || confidenceRaw > 1)) {
    throw new InputError("confidence必须在0到1之间");
  }
  return {
    customerMention: requiredString(source, "customerMention", 200),
    eventType: requiredEnum(source, "eventType", OBSERVATION_TYPES) as ObservationType,
    productName: optionalString(source, "productName", 200) || undefined,
    marketingProductId: source.marketingProductId === undefined
      ? undefined
      : parseEntityId(source.marketingProductId, "marketingProductId"),
    occurredAt: isoDate(source.occurredAt, "occurredAt"),
    facts: facts(source.facts),
    proposedStatePatch: facts(source.proposedStatePatch),
    uncertainties,
    confidence: confidenceRaw as number | null | undefined,
  };
}

export function parseManualObservation(value: unknown): AddManualObservationInput {
  const source = record(value);
  return {
    rawText: requiredString(source, "rawText", 12_000),
    eventType: (enumValue(source, "eventType", OBSERVATION_TYPES) as ObservationType | undefined) ?? "note",
    productName: optionalString(source, "productName", 200) || undefined,
    marketingProductId: source.marketingProductId === undefined
      ? undefined
      : parseEntityId(source.marketingProductId, "marketingProductId"),
    occurredAt: isoDate(source.occurredAt, "occurredAt"),
    facts: facts(source.facts),
    proposedStatePatch: facts(source.proposedStatePatch),
  };
}

export function parseVersion(value: unknown): number {
  return positiveInt(value, "version", { min: 1, max: 2_147_483_647 });
}

export function parseArchiveProfile(value: unknown): { version: number; onOpenTasks?: "cancel" | "keep" } {
  const source = record(value);
  const onOpenTasks = source.onOpenTasks;
  if (onOpenTasks !== undefined && onOpenTasks !== "cancel" && onOpenTasks !== "keep") {
    throw new InputError("onOpenTasks必须是cancel或keep");
  }
  return { version: parseVersion(source.version), onOpenTasks };
}

export function parseDraftId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new InputError("draftId无效");
  return value;
}

export function parseOptionalJourneyStage(value: unknown): JourneyStage | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(JOURNEY_STAGES as readonly string[]).includes(value)) throw new InputError("confirmedJourneyStage取值无效");
  return value as JourneyStage;
}

export function parseOptionalProfileId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new InputError("profileId无效");
  return value;
}

/** Validate UUID path parameters before PostgreSQL attempts a UUID cast. */
export function parseEntityId(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    throw new InputError(`${label}无效`);
  }
  return value;
}
