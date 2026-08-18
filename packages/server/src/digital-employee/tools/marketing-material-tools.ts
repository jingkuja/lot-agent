import type { Tool, ToolResult } from "@lot-agent/core";
import type { MarketingMaterialsService } from "../marketing-service.js";
import { InputError } from "../errors.js";
import { parseEntityId } from "../validators.js";
import {
  parseMarketingBrandAssets,
  parseMarketingProduct,
  parseMarketingProductUpdate,
} from "../marketing-validators.js";

const fact = {
  type: "object",
  properties: { statement: { type: "string" }, evidence: { type: "string" } },
  required: ["statement"],
};
const objection = {
  type: "object",
  properties: { objection: { type: "string" }, response: { type: "string" } },
  required: ["objection", "response"],
};
const benefit = {
  type: "object",
  properties: {
    title: { type: "string" }, description: { type: "string" },
    validFrom: { type: ["string", "null"], description: "ISO 8601 日期" },
    validUntil: { type: ["string", "null"], description: "ISO 8601 日期" },
  },
  required: ["title"],
};
const caseMaterial = {
  type: "object",
  properties: { title: { type: "string" }, summary: { type: "string" }, result: { type: "string" }, assetUrl: { type: "string" } },
  required: ["title", "summary"],
};
const productProperties = {
  name: { type: "string" },
  positioning: { type: "string" },
  coreValues: { type: "array", items: { type: "string" }, maxItems: 30 },
  verifiableFacts: { type: "array", items: fact, maxItems: 50 },
  commonObjections: { type: "array", items: objection, maxItems: 50 },
  currentBenefits: { type: "array", items: benefit, maxItems: 50 },
  prohibitedExpressions: { type: "array", items: { type: "string" }, maxItems: 50 },
  caseMaterials: { type: "array", items: caseMaterial, maxItems: 50 },
};

export function createMarketingMaterialTools(service: MarketingMaterialsService): Tool[] {
  const search: Tool = {
    name: "search_marketing_materials",
    description: "查询当前账号的产品与品牌事实。需要回答产品卖点、可验证事实、异议、有效权益、禁用表达、案例、品牌语气、视觉资产或行动号召时先调用。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "产品名称或定位关键词；留空返回全部" }, includeBrand: { type: "boolean" } },
    },
    async execute(input, context) {
      try {
        const value = object(input);
        const userId = context.userId ?? "default";
        const [products, brandAssets] = await Promise.all([
          service.listProducts(userId, {
            page: 1,
            limit: 20,
            status: "active",
            ...(optionalString(value.query, 200) ? { query: optionalString(value.query, 200) } : {}),
          }),
          value.includeBrand === false ? Promise.resolve(null) : service.getBrandAssets(userId),
        ]);
        return { content: JSON.stringify({ ...products, brandAssets, managementUrl: "/digital-employee/marketing-materials/manage" }) };
      } catch (error) {
        return toolError("查询营销资料失败", error);
      }
    },
  };

  const create: Tool = {
    name: "create_marketing_product",
    description: "新建一条产品营销资料。只保存用户明确提供的事实；不得臆造可验证事实、权益期限或案例结果。",
    parameters: { type: "object", properties: productProperties, required: ["name"] },
    async execute(input, context) {
      try {
        const product = await service.createProduct(context.userId ?? "default", parseMarketingProduct(input));
        return { content: `已新建产品资料「${product.name}」。\n[打开营销资料管理](/digital-employee/marketing-materials/manage)` };
      } catch (error) {
        return toolError("新建产品资料失败", error);
      }
    },
  };

  const update: Tool = {
    name: "update_marketing_product",
    description: "更新 search_marketing_materials 已确认的单个产品资料。数组字段会整体替换，因此只应在用户明确给出完整新值时传入。",
    parameters: {
      type: "object",
      properties: { productId: { type: "string" }, ...productProperties },
      required: ["productId"],
    },
    async execute(input, context) {
      try {
        const value = object(input);
        const userId = context.userId ?? "default";
        const productId = parseEntityId(value.productId, "productId");
        const existing = await service.getProduct(userId, productId);
        const updated = await service.updateProduct(userId, productId, parseMarketingProductUpdate({ ...value, version: existing.version }));
        return { content: `已更新产品资料「${updated.name}」。\n[打开营销资料管理](/digital-employee/marketing-materials/manage)` };
      } catch (error) {
        return toolError("更新产品资料失败", error);
      }
    },
  };

  const brand: Tool = {
    name: "update_marketing_brand_assets",
    description: "新建或更新当前账号唯一的品牌资料，包括品牌语气、视觉资产与标准行动号召。数组字段会整体替换。",
    parameters: {
      type: "object",
      properties: {
        tone: { type: "array", items: { type: "string" }, maxItems: 30 },
        visualAssets: {
          type: "array", maxItems: 50,
          items: { type: "object", properties: { name: { type: "string" }, url: { type: "string" }, type: { type: "string" } }, required: ["name", "url"] },
        },
        standardCallsToAction: { type: "array", items: { type: "string" }, maxItems: 30 },
      },
    },
    async execute(input, context) {
      try {
        const userId = context.userId ?? "default";
        const current = await service.getBrandAssets(userId);
        const saved = await service.saveBrandAssets(userId, parseMarketingBrandAssets({ ...object(input), ...(current ? { version: current.version } : {}) }));
        return { content: `已更新品牌资料（版本 ${saved.version}）。\n[打开营销资料管理](/digital-employee/marketing-materials/manage)` };
      } catch (error) {
        return toolError("更新品牌资料失败", error);
      }
    },
  };

  return [search, create, update, brand];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("参数必须是对象");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new InputError("查询关键词无效");
  return value.trim();
}

function toolError(prefix: string, error: unknown): ToolResult {
  return { content: `${prefix}：${error instanceof Error ? error.message : "服务暂时不可用"}`, isError: true };
}
