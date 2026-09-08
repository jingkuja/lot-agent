import type {
  CohortCount,
  CustomerCohortMetrics,
  CustomerCohortSnapshot,
  Health,
  RelationshipStage,
  StoredCustomerProfile,
} from "../types.js";

export const COHORT_TIME_ZONE = "Asia/Shanghai" as const;
export const COHORT_LOCAL_TIME = "23:00" as const;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const RELATIONSHIP_LABELS: Record<RelationshipStage, string> = {
  lead: "线索",
  prospect: "潜客",
  customer: "客户",
  inactive: "暂无活跃关系",
  lost: "已流失",
};
const HEALTH_LABELS: Record<Health, string> = {
  healthy: "健康",
  watch: "需关注",
  at_risk: "有风险",
};

/** YYYY-MM-DD in the product's fixed Asia/Shanghai business timezone. */
export function cohortDateKey(now: Date): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function isCohortNightlyWindow(now: Date): boolean {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).getUTCHours() >= 23;
}

/** Next 23:00 Asia/Shanghai, represented as an absolute ISO timestamp. */
export function nextCohortRunAt(now: Date): string {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  let runLocalMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    23,
    0,
    0,
    0
  );
  if (local.getTime() >= runLocalMs) runLocalMs += 24 * 60 * 60 * 1_000;
  return new Date(runLocalMs - SHANGHAI_OFFSET_MS).toISOString();
}

/** Minimal aggregate sent to the LLM; all free-form labels stay local. */
export function cohortLlmMetrics(snapshotDate: string, metrics: CustomerCohortMetrics) {
  return {
    snapshotDate,
    totalProfiles: metrics.totalProfiles,
    activeLast7Days: metrics.activeLast7Days,
    dueFollowUps: metrics.dueFollowUps,
    relationshipStages: metrics.relationshipStages.map(({ key, count }) => ({ key, count })),
    health: metrics.health.map(({ key, count }) => ({ key, count })),
    topTagFrequencies: metrics.topTags.map(({ count }) => count),
  };
}

export function buildCohortSnapshot(
  profiles: StoredCustomerProfile[],
  now: Date = new Date()
): CustomerCohortSnapshot {
  const sevenDaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1_000;
  const relationship = countBy(
    profiles,
    (profile) => profile.relationshipStage,
    RELATIONSHIP_LABELS
  );
  const health = countBy(profiles, (profile) => profile.overallHealth, HEALTH_LABELS);
  const tagCounts = new Map<string, number>();
  for (const profile of profiles) {
    for (const tag of new Set(profile.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const metrics: CustomerCohortMetrics = {
    totalProfiles: profiles.length,
    activeLast7Days: profiles.filter((profile) => {
      const activity = profile.lastObservedAt ?? profile.updatedAt;
      return new Date(activity).getTime() >= sevenDaysAgo;
    }).length,
    dueFollowUps: profiles.filter((profile) => {
      if (!profile.nextFollowUpAt) return false;
      return new Date(profile.nextFollowUpAt).getTime() <= now.getTime();
    }).length,
    relationshipStages: relationship,
    health,
    topTags: [...tagCounts.entries()]
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"))
      .slice(0, 4),
  };

  return {
    snapshotDate: cohortDateKey(now),
    summary: cohortSummary(metrics),
    metrics,
    generatedAt: now.toISOString(),
    generationMethod: "logic",
    modelId: null,
  };
}

/** Reject empty/verbose/wrapped model output so the caller can use logic fallback. */
export function parseLlmCohortSummary(value: string): string {
  const summary = value
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^(["“])|(["”])$/g, "")
    .trim();
  if (summary.length < 20 || summary.length > 600) {
    throw new Error("LLM cohort summary length is invalid");
  }
  return summary;
}

function countBy<K extends string>(
  profiles: StoredCustomerProfile[],
  select: (profile: StoredCustomerProfile) => K,
  labels: Record<K, string>
): CohortCount[] {
  const counts = new Map<K, number>();
  for (const profile of profiles) {
    const key = select(profile);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labels[key], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
}

function cohortSummary(metrics: CustomerCohortMetrics): string {
  if (metrics.totalProfiles === 0) {
    return "暂时还没有客户画像。录入客户事实后，系统会在每晚汇总关系阶段、健康度与跟进重点。";
  }
  const leadingStage = metrics.relationshipStages[0];
  const attention = metrics.health
    .filter((item) => item.key === "watch" || item.key === "at_risk")
    .reduce((sum, item) => sum + item.count, 0);
  const pieces = [
    `当前沉淀 ${metrics.totalProfiles} 位客户，${leadingStage?.label ?? "客户"}占比最高（${leadingStage?.count ?? 0} 位）`,
    `近 7 天有 ${metrics.activeLast7Days} 位产生新动态`,
  ];
  if (attention > 0) pieces.push(`${attention} 位需要关注`);
  if (metrics.dueFollowUps > 0) pieces.push(`${metrics.dueFollowUps} 位已到跟进时间`);
  if (metrics.topTags.length > 0) {
    pieces.push(`主要标签为${metrics.topTags.slice(0, 3).map((item) => item.label).join("、")}`);
  }
  return `${pieces.join("；")}。`;
}
