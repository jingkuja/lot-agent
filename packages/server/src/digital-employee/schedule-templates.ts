import type { Pool } from "pg";
import { findContactDetails } from "./group-content-guard.js";
import type { OpportunityService } from "./opportunity-service.js";

export const SCHEDULE_TEMPLATES = ["follow_up_prep", "weekly_review"] as const;
export type ScheduleTemplate = typeof SCHEDULE_TEMPLATES[number];

export interface ScheduleReport {
  summary: string;
  items: Array<{ title: string; body: string }>;
  /** Unattended runs cannot ask: a question ends the run and waits on the today page. */
  question: string | null;
}

interface TemplateDeps {
  pool: Pick<Pool, "query">;
  opportunities: Pick<OpportunityService, "list">;
}

export interface TemplateInput {
  /** False means there is nothing to prepare, so no model is called. */
  worthRunning: boolean;
  instructions: string;
  data: unknown;
}

const FOLLOW_UP_LIMIT = 10;
const PRODUCT_LIMIT = 5;
const REPORT_SUMMARY_MAX = 800;
const REPORT_ITEM_LIMIT = 10;
const REPORT_TITLE_MAX = 120;
const REPORT_BODY_MAX = 600;
const REPORT_QUESTION_MAX = 200;

function withoutContacts(values: string[]): string[] {
  return values.filter((value) => findContactDetails(value).length === 0);
}

const FOLLOW_UP_PREP =
  "Prepare the owner for today's customer follow-ups. For each customer write one item: title is the customer's name, " +
  "body is what to raise first and the opening line to use, based only on the supplied facts. Product facts are confirmed; respect prohibitedExpressions. " +
  "summary says what today looks like.";

const WEEKLY_REVIEW =
  "Review the past seven days of the owner's customer work from the supplied counts. These are totals: do not guess at any individual. " +
  "summary states how the week went. Each item is one concrete thing worth doing next week, with its reason from the counts.";

async function followUpPrep(deps: TemplateDeps, userId: string): Promise<TemplateInput> {
  const { items } = await deps.opportunities.list(userId, { view: "today" });
  const due = items.filter((item) => item.status !== "awaiting_result").slice(0, FOLLOW_UP_LIMIT);
  if (due.length === 0) return { worthRunning: false, instructions: FOLLOW_UP_PREP, data: null };
  const { rows: products } = await deps.pool.query(
    `SELECT name, positioning, core_values, product_notes, prohibited_expressions FROM marketing_products
     WHERE user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT $2`,
    [userId, PRODUCT_LIMIT]
  );
  return {
    worthRunning: true,
    instructions: FOLLOW_UP_PREP,
    data: {
      followUps: due.map((item) => ({
        customer: item.customerName,
        organization: item.organization,
        followUp: withoutContacts([item.title])[0] ?? "",
        objective: withoutContacts([item.objective ?? ""])[0] ?? "",
        method: item.followUpMethod,
        reason: withoutContacts([item.reason])[0] ?? "",
        facts: withoutContacts(item.evidence.map((entry) => entry.fact)),
        overdue: item.overdue,
      })),
      products: products.map((product) => ({
        name: product.name,
        positioning: product.positioning,
        coreValues: product.core_values,
        notes: withoutContacts([product.product_notes ?? ""])[0] ?? "",
        prohibitedExpressions: product.prohibited_expressions,
      })),
    },
  };
}

async function weeklyReview(pool: Pick<Pool, "query">, userId: string): Promise<TemplateInput> {
  const { rows: [counts] } = await pool.query(
    `SELECT
       (SELECT count(*) FROM de_customer_profiles WHERE user_id=$1 AND status='active')::int AS customers,
       (SELECT count(*) FROM de_customer_profiles WHERE user_id=$1 AND created_at > now() - interval '7 days')::int AS new_customers,
       (SELECT count(*) FROM de_customer_observations WHERE user_id=$1 AND created_at > now() - interval '7 days')::int AS notes,
       (SELECT count(*) FROM de_follow_up_tasks WHERE user_id=$1 AND completed_at > now() - interval '7 days')::int AS follow_ups_done,
       (SELECT count(*) FROM de_follow_up_tasks WHERE user_id=$1 AND status='pending' AND scheduled_at < now())::int AS follow_ups_overdue,
       (SELECT count(*) FROM de_marketing_campaigns WHERE user_id=$1 AND created_at > now() - interval '7 days')::int AS new_campaigns,
       (SELECT count(*) FROM de_marketing_asset_library WHERE user_id=$1 AND created_at > now() - interval '7 days')::int AS new_assets`,
    [userId]
  );
  return { worthRunning: Number(counts?.customers ?? 0) > 0, instructions: WEEKLY_REVIEW, data: counts };
}

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Rejects anything that is not a report, so a malformed answer is a failed run rather than a blank card. */
export function parseScheduleReport(raw: string): ScheduleReport {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(cleaned) as Record<string, unknown>;
  const summary = bounded(value.summary, REPORT_SUMMARY_MAX);
  if (!summary) throw new Error("schedule report has no summary");
  const items = (Array.isArray(value.items) ? value.items : []).slice(0, REPORT_ITEM_LIMIT).flatMap((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const title = bounded(item.title, REPORT_TITLE_MAX);
    const body = bounded(item.body, REPORT_BODY_MAX);
    return title && body ? [{ title, body }] : [];
  });
  return { summary, items, question: bounded(value.question, REPORT_QUESTION_MAX) || null };
}

/** Everything a run may read. Each template only reads: writing has no path from here. */
export function collectTemplate(template: ScheduleTemplate, deps: TemplateDeps, userId: string): Promise<TemplateInput> {
  return template === "follow_up_prep" ? followUpPrep(deps, userId) : weeklyReview(deps.pool, userId);
}
