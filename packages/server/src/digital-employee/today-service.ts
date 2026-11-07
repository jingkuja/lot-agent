import type { Pool } from "pg";
import type { AssignmentService } from "./assignment-service.js";
import type { CustomerAcquisitionService, DeploymentAwaitingFeedback } from "./acquisition-service.js";
import type { BriefService } from "./brief-service.js";
import type { OpportunityListItem } from "./opportunity-types.js";
import type { OpportunityService } from "./opportunity-service.js";
import type { PendingProposal, ProposalService } from "./proposal-service.js";
import type { ScheduleRun, ScheduleService } from "./schedule-service.js";
import type { EmployeeSettingsService } from "./settings-service.js";

export type TodayItemKind = "proposal" | "opportunity" | "recommendation" | "follow_up" | "result" | "report" | "assignment";
type Recommendation = Awaited<ReturnType<CustomerAcquisitionService["listRecommendations"]>>["items"][number];
type AssignmentAttention = Awaited<ReturnType<AssignmentService["attention"]>>[number];

/** One unit of work, whichever table it comes from. Interface copy is built from these fields. */
export interface TodayItem {
  id: string;
  kind: TodayItemKind;
  subject: { type: "customer" | "segment" | "campaign" | "asset"; id: string; label: string } | null;
  title: string;
  reason: string;
  evidence: Array<{ fact: string }>;
  priority: "high" | "normal" | "low";
  dueAt: string | null;
  source: { type: string; id: string; version?: number };
  proposal?: PendingProposal;
  opportunity?: OpportunityListItem;
  recommendation?: Recommendation;
  deployment?: DeploymentAwaitingFeedback;
  scheduleRun?: ScheduleRun;
  assignment?: AssignmentAttention;
}

export interface RunningWork {
  id: string;
  type: string;
  status: string;
  progress: number;
  stage: string | null;
  createdAt: string;
}

const RECOMMENDATION_LIMIT = 6;
const RUNNING_LIMIT = 10;
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 } as const;

/** A live projection of the work tables. It keeps no state of its own. */
export class TodayService {
  constructor(
    private readonly pool: Pool,
    private readonly settings: Pick<EmployeeSettingsService, "get">,
    private readonly opportunities: Pick<OpportunityService, "list">,
    private readonly acquisition: Pick<CustomerAcquisitionService, "listRecommendations" | "listDeploymentsAwaitingFeedback">,
    private readonly proposals: Pick<ProposalService, "listPending">,
    private readonly briefs: Pick<BriefService, "latest">,
    private readonly schedules: Pick<ScheduleService, "pendingReports">,
    private readonly assignments: Pick<AssignmentService, "attention">,
  ) {}

  async get(userId: string) {
    // One at a time: each list first closes stale actions, and those updates share rows.
    const today = await this.opportunities.list(userId, { view: "today" });
    const pending = await this.opportunities.list(userId, { view: "pending" });
    const snoozed = await this.opportunities.list(userId, { view: "snoozed" });
    const [settings, recommendations, deployments, proposals, running, brief, reports, assignments] = await Promise.all([
      this.settings.get(userId),
      this.acquisition.listRecommendations(userId, "pending"),
      this.acquisition.listDeploymentsAwaitingFeedback(userId),
      this.proposals.listPending(userId),
      this.runningWork(userId),
      this.briefs.latest(userId),
      this.schedules.pendingReports(userId),
      this.assignments.attention(userId),
    ]);
    const items = [
      ...proposals.map(proposalItem),
      ...pending.items.map((item) => workItem("opportunity", item)),
      ...recommendations.items.slice(0, RECOMMENDATION_LIMIT).map(recommendationItem),
      ...today.items.map((item) => workItem(item.status === "awaiting_result" ? "result" : "follow_up", item)),
      ...deployments.map(deploymentItem),
      ...reports.map(reportItem),
      ...assignments.map(assignmentItem),
    ].sort(byPriority);
    return {
      employee: { name: settings.employeeName },
      brief,
      items,
      running,
      snoozedCount: snoozed.items.length,
      hasProfiles: today.hasProfiles,
      lastDiscoveredAt: today.lastDiscoveredAt,
    };
  }

  /** What the brand area and the desktop notification need. */
  async summary(userId: string) {
    const [{ items, brief }, settings] = await Promise.all([this.get(userId), this.settings.get(userId)]);
    return { pending: items.length, brief, desktopReminder: settings.desktopReminder };
  }

  private async runningWork(userId: string): Promise<RunningWork[]> {
    const { rows } = await this.pool.query(
      `SELECT id, type, status, progress, stage, created_at FROM tasks
       WHERE user_id=$1 AND status IN ('pending','running')
         AND (type IN ('opportunity.discover','employee.schedule.run') OR input->>'featureScope'='customer-acquisition')
       ORDER BY created_at DESC LIMIT $2`,
      [userId, RUNNING_LIMIT]
    );
    return rows.map((row) => ({
      id: String(row.id), type: String(row.type), status: String(row.status), progress: Number(row.progress),
      stage: row.stage ? String(row.stage) : null, createdAt: new Date(row.created_at).toISOString(),
    }));
  }
}

export function countToday(items: TodayItem[]) {
  return {
    confirm: items.filter((item) => ["proposal", "opportunity", "recommendation", "assignment"].includes(item.kind)).length,
    followUps: items.filter((item) => item.kind === "follow_up").length,
    results: items.filter((item) => item.kind === "result").length,
  };
}

function byPriority(left: TodayItem, right: TodayItem): number {
  return PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
    || (left.dueAt ?? "9").localeCompare(right.dueAt ?? "9");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function proposalSubject(proposal: PendingProposal): TodayItem["subject"] {
  const { preview } = proposal;
  if (typeof preview.profileId === "string") {
    return { type: "customer", id: preview.profileId, label: text(preview.customerName) };
  }
  if (typeof preview.assetId === "string") return { type: "asset", id: preview.assetId, label: text(preview.title) };
  if (typeof preview.campaignId === "string") return { type: "campaign", id: preview.campaignId, label: text(preview.name) };
  return null;
}

function proposalItem(proposal: PendingProposal): TodayItem {
  const { preview } = proposal;
  return {
    id: `proposal:${proposal.id}`,
    kind: "proposal",
    subject: proposalSubject(proposal),
    title: text(preview.title) || text(preview.name) || text(preview.customerMention),
    reason: "",
    evidence: [],
    priority: "normal",
    dueAt: null,
    source: { type: proposal.kind, id: proposal.id },
    proposal,
  };
}

function workItem(kind: TodayItemKind, item: OpportunityListItem): TodayItem {
  return {
    id: `${kind}:${item.id}`,
    kind,
    subject: { type: "customer", id: item.profileId, label: item.customerName },
    title: item.title,
    reason: item.reason,
    evidence: item.evidence.map((entry) => ({ fact: entry.fact })),
    priority: item.overdue ? "high" : item.priority,
    dueAt: item.scheduledAt,
    source: item.actionId
      ? { type: "action", id: item.actionId, version: item.actionVersion }
      : { type: "opportunity", id: item.opportunityId },
    opportunity: item,
  };
}

function recommendationItem(item: Recommendation): TodayItem {
  return {
    id: `recommendation:${item.id}`,
    kind: "recommendation",
    subject: item.segmentId ? { type: "segment", id: item.segmentId, label: item.segmentName ?? item.targetSegmentDescription } : null,
    title: item.theme,
    reason: item.targetSegmentDescription,
    evidence: item.reasoning.map((fact: string) => ({ fact })),
    priority: "low",
    dueAt: null,
    source: { type: "recommendation", id: item.id },
    recommendation: item,
  };
}

/** A question outranks a finished report: nothing can continue until the owner answers it. */
function reportItem(run: ScheduleRun): TodayItem {
  const report = run.report!;
  return {
    id: `report:${run.id}`,
    kind: "report",
    subject: null,
    title: run.template,
    reason: report.summary,
    evidence: [],
    priority: report.question ? "high" : "normal",
    dueAt: run.finishedAt,
    source: { type: "schedule_run", id: run.id },
    scheduleRun: run,
  };
}

/** Work has stopped until the owner acts, so it outranks anything that can wait. */
function assignmentItem(assignment: AssignmentAttention): TodayItem {
  return {
    id: assignment.decision ? `assignment:${assignment.decision.id}` : `assignment:${assignment.rootId}`,
    kind: "assignment",
    subject: null,
    title: assignment.title,
    reason: assignment.decision?.question ?? "",
    evidence: [],
    priority: "high",
    dueAt: assignment.createdAt,
    source: { type: "assignment", id: assignment.rootId },
    assignment,
  };
}

function deploymentItem(item: DeploymentAwaitingFeedback): TodayItem {
  return {
    id: `result:${item.id}`,
    kind: "result",
    subject: { type: "asset", id: item.assetId, label: item.title },
    title: item.title,
    reason: "",
    evidence: [],
    priority: "normal",
    dueAt: item.deployedAt,
    source: { type: "deployment", id: item.id },
    deployment: item,
  };
}
