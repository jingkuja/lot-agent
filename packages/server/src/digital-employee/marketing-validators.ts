import { InputError } from "./errors.js";
import type {
  MarketingBrandAssetsInput,
  MarketingCaseMaterial,
  MarketingFact,
  MarketingObjection,
  MarketingProductInput,
  MarketingProductListFilters,
  MarketingProductUpdateInput,
  MarketingVisualAsset,
  MarketingBenefit,
} from "./marketing-types.js";

function object(value: unknown, label = "请求体"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(`${label}必须是对象`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new InputError(`${label}不能为空`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) {
    throw new InputError(`${label}格式无效`);
  }
  return value.trim();
}

function strings(value: unknown, label: string, maxItems = 30, maxLength = 500): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new InputError(`${label}格式无效`);
  const result = value.map((item) => text(item, label, maxLength, true)!);
  return [...new Set(result)];
}

function structured<T>(
  value: unknown,
  label: string,
  maxItems: number,
  parser: (item: Record<string, unknown>) => T
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new InputError(`${label}格式无效`);
  return value.map((item) => parser(object(item, `${label}项`)));
}

function date(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null || value === "") return value === undefined ? undefined : null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new InputError(`${label}日期无效`);
  return new Date(value).toISOString();
}

function optionalAssetUrl(value: unknown, label: string): string | undefined {
  const output = text(value, label, 2_000);
  if (output === undefined) return undefined;
  if (output.startsWith("/")) return output;
  try {
    const parsed = new URL(output);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return output;
  } catch {
    // Fall through to the stable input error below.
  }
  throw new InputError(`${label}只支持HTTP(S)或站内路径`);
}

function requiredAssetUrl(value: unknown, label: string): string {
  const output = text(value, label, 2_000, true)!;
  if (output.startsWith("/")) return output;
  try {
    const parsed = new URL(output);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return output;
  } catch {
    // Fall through to the stable input error below.
  }
  throw new InputError(`${label}只支持HTTP(S)或站内路径`);
}

function facts(value: unknown): MarketingFact[] | undefined {
  return structured(value, "verifiableFacts", 50, (item) => ({
    statement: text(item.statement, "可验证事实", 1_000, true)!,
    ...(text(item.evidence, "事实依据", 2_000) !== undefined ? { evidence: text(item.evidence, "事实依据", 2_000) } : {}),
  }));
}

function objections(value: unknown): MarketingObjection[] | undefined {
  return structured(value, "commonObjections", 50, (item) => ({
    objection: text(item.objection, "常见异议", 1_000, true)!,
    response: text(item.response, "异议回应", 2_000, true)!,
  }));
}

function benefits(value: unknown): MarketingBenefit[] | undefined {
  return structured(value, "currentBenefits", 50, (item) => {
    const validFrom = date(item.validFrom, "权益开始");
    const validUntil = date(item.validUntil, "权益结束");
    if (validFrom && validUntil && new Date(validFrom) > new Date(validUntil)) throw new InputError("权益结束时间不能早于开始时间");
    return {
      title: text(item.title, "权益名称", 500, true)!,
      ...(text(item.description, "权益说明", 2_000) !== undefined ? { description: text(item.description, "权益说明", 2_000) } : {}),
      ...(validFrom !== undefined ? { validFrom } : {}),
      ...(validUntil !== undefined ? { validUntil } : {}),
    };
  });
}

function cases(value: unknown): MarketingCaseMaterial[] | undefined {
  return structured(value, "caseMaterials", 50, (item) => ({
    title: text(item.title, "案例标题", 500, true)!,
    summary: text(item.summary, "案例摘要", 3_000, true)!,
    ...(text(item.result, "案例结果", 2_000) !== undefined ? { result: text(item.result, "案例结果", 2_000) } : {}),
    ...(optionalAssetUrl(item.assetUrl, "素材链接") !== undefined ? { assetUrl: optionalAssetUrl(item.assetUrl, "素材链接") } : {}),
  }));
}

function visuals(value: unknown): MarketingVisualAsset[] | undefined {
  return structured(value, "visualAssets", 50, (item) => ({
    name: text(item.name, "视觉资产名称", 500, true)!,
    url: requiredAssetUrl(item.url, "视觉资产链接"),
    ...(text(item.type, "视觉资产类型", 100) !== undefined ? { type: text(item.type, "视觉资产类型", 100) } : {}),
  }));
}

function productFields(source: Record<string, unknown>, requireName: boolean): MarketingProductInput | Partial<MarketingProductInput> {
  const name = text(source.name, "产品名称", 200, requireName);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(text(source.positioning, "产品定位", 4_000) !== undefined ? { positioning: text(source.positioning, "产品定位", 4_000) } : {}),
    ...(strings(source.coreValues, "核心价值", 30, 500) !== undefined ? { coreValues: strings(source.coreValues, "核心价值", 30, 500) } : {}),
    ...(facts(source.verifiableFacts) !== undefined ? { verifiableFacts: facts(source.verifiableFacts) } : {}),
    ...(objections(source.commonObjections) !== undefined ? { commonObjections: objections(source.commonObjections) } : {}),
    ...(benefits(source.currentBenefits) !== undefined ? { currentBenefits: benefits(source.currentBenefits) } : {}),
    ...(strings(source.prohibitedExpressions, "禁用表达", 50, 500) !== undefined ? { prohibitedExpressions: strings(source.prohibitedExpressions, "禁用表达", 50, 500) } : {}),
    ...(cases(source.caseMaterials) !== undefined ? { caseMaterials: cases(source.caseMaterials) } : {}),
  };
}

export function parseMarketingProduct(value: unknown): MarketingProductInput {
  return productFields(object(value), true) as MarketingProductInput;
}

export function parseMarketingProductUpdate(value: unknown): MarketingProductUpdateInput {
  const source = object(value);
  const version = Number(source.version);
  if (!Number.isInteger(version) || version < 1) throw new InputError("version无效");
  const fields = productFields(source, false);
  if (Object.keys(fields).length === 0) throw new InputError("没有可更新的产品字段");
  return { ...fields, version } as MarketingProductUpdateInput;
}

export function parseMarketingBrandAssets(value: unknown): MarketingBrandAssetsInput {
  const source = object(value);
  const version = source.version === undefined ? undefined : Number(source.version);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new InputError("version无效");
  const result: MarketingBrandAssetsInput = {
    ...(strings(source.tone, "品牌语气", 30, 500) !== undefined ? { tone: strings(source.tone, "品牌语气", 30, 500) } : {}),
    ...(visuals(source.visualAssets) !== undefined ? { visualAssets: visuals(source.visualAssets) } : {}),
    ...(strings(source.standardCallsToAction, "标准行动号召", 30, 1_000) !== undefined ? { standardCallsToAction: strings(source.standardCallsToAction, "标准行动号召", 30, 1_000) } : {}),
    ...(version !== undefined ? { version } : {}),
  };
  if (Object.keys(result).filter((key) => key !== "version").length === 0) throw new InputError("没有可更新的品牌字段");
  return result;
}

export function parseMarketingProductList(query: Record<string, string>): MarketingProductListFilters {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new InputError("page无效");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InputError("limit无效");
  if (query.status !== undefined && query.status !== "active" && query.status !== "archived") throw new InputError("status无效");
  return {
    page,
    limit,
    ...(query.q?.trim() ? { query: query.q.trim().slice(0, 200) } : {}),
    ...(query.status ? { status: query.status as "active" | "archived" } : {}),
  };
}
