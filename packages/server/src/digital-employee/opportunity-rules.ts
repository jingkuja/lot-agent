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
    const riskDetail = hasComplaint
      ? (observation?.rawText?.slice(0, 80) || "近期投诉")
      : (riskProduct ? `${riskProduct.productName}存在未解决问题` : (candidate.summary.slice(0, 80) || "存在未解决风险"));
    output.push(make(candidate, "risk_recovery", {
      title: `优先安抚并处理${candidate.displayName}的服务风险`,
      objective: riskProduct
        ? `电话确认「${riskProduct.productName}」问题处理进度，给出明确时限与补偿口径，恢复信任`
        : "电话确认投诉/风险处理状态，给出明确时限并恢复客户信任",
      method: "电话",
      priority: "high",
      reason: `策略：先服务后销售。依据：${riskDetail}`,
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
        title: `推进${candidate.displayName}的「${product.productName}」续费`,
        objective: `电话确认「${product.productName}」续费意向、决策人和期望时间，并预约下一次确认节点`,
        method: "电话",
        priority: "high",
        reason: `策略：锁定续费窗口。${product.productName}已进入续费阶段${candidate.summary ? `；画像摘要：${candidate.summary.slice(0, 60)}` : ""}`,
        evidence: [{ fact: `${product.productName}当前处于续费阶段`, occurredAt: product.updatedAt, sourceType: "product_state" }],
        readiness: "actionable", risks: [], product, now,
      }));
    }
  }

  const activeProduct = candidate.products.find((product) => ["evaluating", "trial"].includes(product.journeyStage));
  const recentSignal = observation && now.getTime() - Date.parse(observedAt) <= 30 * DAY;
  if (["lead", "prospect"].includes(candidate.relationshipStage) && (activeProduct || recentSignal)) {
    const stageLabel = activeProduct?.journeyStage === "trial" ? "试用" : "评估";
    const signal = observation?.rawText?.slice(0, 72) || candidate.summary.slice(0, 72) || "近期有互动";
    output.push(make(candidate, "prospect_progress", {
      title: activeProduct
        ? `推进${candidate.displayName}的「${activeProduct.productName}」${stageLabel}`
        : `推进${candidate.displayName}的当前需求`,
      objective: activeProduct
        ? `企微确认「${activeProduct.productName}」决策条件、卡点和下一步（演示/报价/试用反馈），形成可执行约定`
        : "企微确认当前需求、决策人与时间点，形成有效下一步",
      method: "企微/微信",
      priority: candidate.nextFollowUpAt && Date.parse(candidate.nextFollowUpAt) <= now.getTime() ? "high" : "normal",
      reason: activeProduct
        ? `策略：推进${stageLabel}转化。依据：${activeProduct.productName}处于${stageLabel}；信号：${signal}`
        : `策略：推进需求澄清。依据：${signal}`,
      evidence: [observationEvidence, ...(activeProduct ? [{ fact: `${activeProduct.productName}处于${activeProduct.journeyStage === "trial" ? "试用中" : "评估中"}`, occurredAt: activeProduct.updatedAt, sourceType: "product_state" }] : [])],
      readiness: observation || candidate.summary ? "actionable" : "needs_info", risks: promotionRisks, product: activeProduct, now,
    }));
  }

  const lastContact = candidate.lastContactAt ? Date.parse(candidate.lastContactAt) : NaN;
  if (!hasRisk && Number.isFinite(lastContact) && now.getTime() - lastContact >= 30 * DAY &&
      (candidate.relationshipStage === "prospect" || candidate.relationshipStage === "customer" || candidate.relationshipStage === "inactive")) {
    const silentDays = Math.floor((now.getTime() - lastContact) / DAY);
    output.push(make(candidate, "silent_reengage", {
      title: `重新联系已沉默${silentDays}天的${candidate.displayName}`,
      objective: activeProduct
        ? `企微轻量问候并确认现状，试探「${activeProduct.productName}」是否仍有需求，预约一次短沟通`
        : "企微轻量问候并确认现状，恢复有效沟通并约定下一步",
      method: "企微/微信",
      priority: silentDays >= 60 ? "high" : "normal",
      reason: `策略：沉默唤醒。曾有真实关系，已${silentDays}天未联系${candidate.summary ? `；历史摘要：${candidate.summary.slice(0, 60)}` : ""}`,
      evidence: [{ fact: `距上次联系已超过 ${silentDays} 天`, occurredAt: candidate.lastContactAt!, sourceType: "profile" }],
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
