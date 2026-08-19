import { createHash } from "node:crypto";
import type { OpportunityEvidence, OpportunityPriority, OpportunityReadiness, OpportunityRisk, OpportunityType } from "./opportunity-types.js";

export interface DiscoveryCandidate {
  profileId: string;
  displayName: string;
  relationshipStage: "lead" | "prospect" | "customer" | "inactive" | "lost";
  overallHealth: "healthy" | "watch" | "at_risk";
  summary: string;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  updatedAt: string;
  latestObservation?: {
    id: string;
    rawText: string;
    eventType: string | null;
    occurredAt: string;
  } | null;
  products: Array<{
    productKey: string;
    productName: string;
    journeyStage: string;
    satisfaction: string;
    health: string;
    currentIssues: unknown[];
    updatedAt: string;
  }>;
}

export interface RuleOpportunity {
  profileId: string;
  type: OpportunityType;
  title: string;
  objective: string;
  method: string;
  suggestedAt: string;
  priority: OpportunityPriority;
  reason: string;
  evidence: OpportunityEvidence[];
  readiness: OpportunityReadiness;
  risks: OpportunityRisk[];
  productKey: string | null;
  productName: string | null;
  validUntil: string;
  dedupKey: string;
}

const DAY = 86_400_000;

/** Pure, deterministic fallback: every generated opportunity points to dated facts. */
export function discoverByRules(candidate: DiscoveryCandidate, now = new Date()): RuleOpportunity[] {
  if (candidate.relationshipStage === "lost") return [];
  const output: RuleOpportunity[] = [];
  const observation = candidate.latestObservation;
  const observedAt = observation?.occurredAt ?? candidate.updatedAt;
  const observationEvidence: OpportunityEvidence = {
    fact: observation?.rawText.slice(0, 240) || candidate.summary || "客户画像近期有更新",
    occurredAt: observedAt,
    sourceType: observation ? "observation" : "profile",
    ...(observation ? { sourceId: observation.id } : {}),
  };
  const riskProduct = candidate.products.find((product) =>
    product.health === "at_risk" || product.satisfaction === "dissatisfied" || product.currentIssues.length > 0
  );
  const hasComplaint = observation?.eventType === "complaint";
  const hasRisk = candidate.overallHealth === "at_risk" || Boolean(riskProduct) || hasComplaint;

  if (hasRisk) {
    const risks: OpportunityRisk[] = [{ code: "unresolved_risk", message: "当前存在投诉、不满或未解决问题，应先修复关系", blocking: false }];
    output.push(make(candidate, "risk_recovery", {
      title: `优先处理${candidate.displayName}的服务风险`,
      objective: "确认问题处理状态并恢复客户信任",
      method: "电话",
      priority: "high",
      reason: hasComplaint ? "近期记录了客户投诉，应优先服务处理" : "客户画像或产品状态显示存在未解决风险",
      evidence: [observationEvidence, ...(riskProduct ? [{ fact: `${riskProduct.productName}存在未解决问题`, occurredAt: riskProduct.updatedAt, sourceType: "product_state" }] : [])],
      readiness: "actionable",
      risks,
      product: riskProduct,
      now,
    }));
  }

  // A live risk blocks promotional opportunities, but keeping them visible is
  // useful: the UI greys them and explains why they cannot be accepted yet.
  const promotionRisks: OpportunityRisk[] = hasRisk
    ? [{ code: "active_risk", message: "当前存在待处理风险，完成服务处理后再采纳", blocking: true }]
    : [];

  for (const product of candidate.products) {
    if (product.journeyStage === "renewal" && !hasRisk) {
      output.push(make(candidate, "renewal", {
        title: `推进${candidate.displayName}的续费安排`, objective: "确认续费意向和时间安排", method: "电话",
        priority: "high", reason: `${product.productName}已进入续费阶段`,
        evidence: [{ fact: `${product.productName}当前处于续费阶段`, occurredAt: product.updatedAt, sourceType: "product_state" }],
        readiness: "actionable", risks: [], product, now,
      }));
    }
  }

  const activeProduct = candidate.products.find((product) => ["evaluating", "trial"].includes(product.journeyStage));
  const recentSignal = observation && now.getTime() - Date.parse(observedAt) <= 30 * DAY;
  if (["lead", "prospect"].includes(candidate.relationshipStage) && (activeProduct || recentSignal)) {
    output.push(make(candidate, "prospect_progress", {
      title: `推进${candidate.displayName}的当前需求`, objective: "确认需求与决策条件，形成有效下一步", method: "企微/微信",
      priority: candidate.nextFollowUpAt && Date.parse(candidate.nextFollowUpAt) <= now.getTime() ? "high" : "normal",
      reason: activeProduct ? `${activeProduct.productName}处于${activeProduct.journeyStage === "trial" ? "试用" : "评估"}阶段` : "近期画像记录了客户需求或互动",
      evidence: [observationEvidence, ...(activeProduct ? [{ fact: `${activeProduct.productName}处于${activeProduct.journeyStage === "trial" ? "试用中" : "评估中"}`, occurredAt: activeProduct.updatedAt, sourceType: "product_state" }] : [])],
      readiness: observation || candidate.summary ? "actionable" : "needs_info", risks: promotionRisks, product: activeProduct, now,
    }));
  }

  const lastContact = candidate.lastContactAt ? Date.parse(candidate.lastContactAt) : NaN;
  if (!hasRisk && Number.isFinite(lastContact) && now.getTime() - lastContact >= 30 * DAY &&
      (candidate.relationshipStage === "prospect" || candidate.relationshipStage === "customer" || candidate.relationshipStage === "inactive")) {
    output.push(make(candidate, "silent_reengage", {
      title: `重新联系${candidate.displayName}`, objective: "确认客户现状并恢复有效沟通", method: "企微/微信",
      priority: now.getTime() - lastContact >= 60 * DAY ? "high" : "normal", reason: "曾有真实关系，但已超过合理时间未联系",
      evidence: [{ fact: "距上次联系已超过 30 天", occurredAt: candidate.lastContactAt!, sourceType: "profile" }],
      readiness: candidate.summary ? "tryable" : "needs_info", risks: [], product: activeProduct, now,
    }));
  }

  return output;
}

function make(candidate: DiscoveryCandidate, type: OpportunityType, input: {
  title: string; objective: string; method: string; priority: OpportunityPriority; reason: string;
  evidence: OpportunityEvidence[]; readiness: OpportunityReadiness; risks: OpportunityRisk[];
  product?: DiscoveryCandidate["products"][number]; now: Date;
}): RuleOpportunity {
  const factVersion = input.evidence.map((item) => `${item.sourceId ?? item.sourceType}:${item.occurredAt}`).join("|");
  const fingerprint = createHash("sha256").update(factVersion).digest("hex").slice(0, 20);
  return {
    profileId: candidate.profileId, type, title: input.title, objective: input.objective, method: input.method,
    suggestedAt: input.now.toISOString(), priority: input.priority, reason: input.reason,
    evidence: input.evidence.slice(0, 3), readiness: input.readiness, risks: input.risks,
    productKey: input.product?.productKey ?? null, productName: input.product?.productName ?? null,
    validUntil: new Date(input.now.getTime() + 30 * DAY).toISOString(),
    dedupKey: `${candidate.profileId}:${type}:${input.product?.productKey ?? "general"}:${fingerprint}`,
  };
}
