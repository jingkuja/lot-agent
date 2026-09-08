import type { CustomerProductState, CustomerProfile } from "../types.js";

/**
 * A deterministic, contact-free summary used in profile lists. It never
 * includes encrypted contact details or raw observations. It still contains
 * customer-authored profile fields, so callers must redact before LLM use.
 */
export function buildProfileSummary(
  profile: Pick<CustomerProfile, "displayName" | "relationshipStage" | "overallHealth" | "tags">,
  products: Array<Pick<CustomerProductState, "productName" | "journeyStage" | "satisfaction" | "health" | "currentIssues" | "objections">>
): string {
  const head = `${profile.displayName}：${relationshipLabel(profile.relationshipStage)}，整体${healthLabel(profile.overallHealth)}。`;
  const productParts = products.slice(0, 6).map((product) => {
    const facts: string[] = [product.productName, journeyLabel(product.journeyStage)];
    if (product.satisfaction !== "unknown") facts.push(satisfactionLabel(product.satisfaction));
    if (product.health !== "healthy") facts.push(healthLabel(product.health));
    const issue = firstShortText(product.currentIssues) ?? firstShortText(product.objections);
    if (issue) facts.push(issue);
    return facts.join("，");
  });
  const tags = profile.tags.slice(0, 8);
  const tail = [productParts.length ? `产品：${productParts.join("；")}` : "", tags.length ? `标签：${tags.join("、")}` : ""]
    .filter(Boolean)
    .join("。 ");
  return `${head}${tail ? ` ${tail}。` : ""}`.slice(0, 1_800);
}

function firstShortText(items: unknown[]): string | undefined {
  for (const item of items) {
    if (typeof item === "string" && item.trim()) return item.trim().slice(0, 120);
    if (item && typeof item === "object") {
      const candidate = (item as Record<string, unknown>).summary ?? (item as Record<string, unknown>).text;
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 120);
    }
  }
  return undefined;
}

function relationshipLabel(value: CustomerProfile["relationshipStage"]): string {
  return ({ lead: "线索", prospect: "潜客", customer: "客户", inactive: "暂无活跃关系", lost: "已流失" })[value];
}

function healthLabel(value: CustomerProfile["overallHealth"] | CustomerProductState["health"]): string {
  return ({ healthy: "健康", watch: "需关注", at_risk: "有风险" })[value];
}

function journeyLabel(value: CustomerProductState["journeyStage"]): string {
  return ({
    unknown: "阶段未知",
    evaluating: "评估中",
    trial: "试用中",
    purchased: "已购买",
    using: "使用中",
    renewal: "续费阶段",
    paused: "已暂停",
    lost: "已放弃",
    churned: "已流失",
  })[value];
}

function satisfactionLabel(value: CustomerProductState["satisfaction"]): string {
  return ({ satisfied: "满意", neutral: "满意度一般", dissatisfied: "不满意", unknown: "满意度未知" })[value];
}
