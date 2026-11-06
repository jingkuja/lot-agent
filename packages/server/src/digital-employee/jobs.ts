import type { JobQueue } from "@lot-agent/core";
import type { DB } from "../db/database.js";
import { CustomerAcquisitionService } from "./acquisition-service.js";
import { BriefService, briefMessage } from "./brief-service.js";
import { digitalEmployeeDailyScanEnabled, digitalEmployeeSchedulesEnabled } from "./feature-scope.js";
import { OpportunityService } from "./opportunity-service.js";
import { PRODUCT_DOCUMENT_JOB, ProductDocumentService, type ProductDocumentParser } from "./product-document-service.js";
import { ProposalService } from "./proposal-service.js";
import { createOpportunityAdviceGenerator, createScheduleReportGenerator } from "./runtime.js";
import { SCHEDULE_JOB, ScheduleService } from "./schedule-service.js";
import type { DigitalEmployeeService } from "./service.js";
import { EmployeeSettingsService } from "./settings-service.js";
import { TodayService, countToday } from "./today-service.js";

const COHORT_SUMMARY_CHECK_MS = 5 * 60 * 1000;
const DISCOVERY_CHECK_MS = 60 * 1000;
const SCHEDULE_CHECK_MS = 60 * 1000;
const DELIVERY_BATCH = 20;

export interface OwnerMessage {
  text: string;
  requestId: string;
}

/** The port has no recipient: a brief can only ever reach the account's owner. */
export type SendToOwner = (userId: string, message: OwnerMessage) => Promise<unknown>;

interface ScheduleOptions {
  sendToOwner?: SendToOwner;
  english: boolean;
}

function every(intervalMs: number, label: string, run: () => Promise<void>) {
  const tick = () => run().catch((error) => console.warn(`${label} failed:`, error));
  void tick();
  setInterval(tick, intervalMs).unref();
}

export async function deliverBriefs(service: Pick<DigitalEmployeeService, "briefs" | "settings">, options: ScheduleOptions) {
  const { sendToOwner } = options;
  if (!sendToOwner || !digitalEmployeeDailyScanEnabled()) return;
  for (const brief of await service.briefs.claimFeishuDeliveries(DELIVERY_BATCH)) {
    try {
      const { employeeName } = await service.settings.get(brief.userId);
      await sendToOwner(brief.userId, {
        text: briefMessage(brief.counts, employeeName, options.english),
        requestId: `employee-brief:${brief.userId}:${brief.date}`,
      });
      await service.briefs.markDelivered(brief.id);
    } catch (error) {
      console.warn(`[employee-brief] Feishu delivery failed for user ${brief.userId}:`, error);
    }
  }
}

/** The API process's timers. Each account's own schedule and idempotency keys live in the services. */
export function registerDigitalEmployeeJobs(service: DigitalEmployeeService, options: ScheduleOptions) {
  // Cohort portraits are account-scoped aggregates. Only opted-in accounts are selected after
  // 23:00 Asia/Shanghai; the snapshot's (user, date) key prevents duplicate billing across restarts.
  every(COHORT_SUMMARY_CHECK_MS, "Customer cohort summary scheduler", async () => {
    const completed = await service.runNightlyCohortSummaries();
    if (completed > 0) console.log(`Generated ${completed} nightly customer cohort portrait(s)`);
  });
  // The database selects only due rows and advances next_run_at, while the daily
  // idempotency key prevents restarts or overlapping ticks from creating duplicate runs.
  every(DISCOVERY_CHECK_MS, "Opportunity discovery scheduler", async () => {
    if (digitalEmployeeDailyScanEnabled()) await service.opportunities.ensureScanSettings();
    const queued = await service.opportunities.enqueueDueDiscoveries();
    if (queued > 0) console.log(`Queued ${queued} daily opportunity discovery task(s)`);
    await deliverBriefs(service, options);
  });
  if (digitalEmployeeSchedulesEnabled()) {
    every(SCHEDULE_CHECK_MS, "Employee schedule dispatcher", async () => {
      const queued = await service.schedules.dispatchDue();
      if (queued > 0) console.log(`Queued ${queued} scheduled employee run(s)`);
    });
  }
}

interface WorkerQueue {
  process: JobQueue["process"];
  updateProgress(id: string, value: number, stage?: string): Promise<void>;
}

interface WorkerPorts {
  queue: WorkerQueue;
  db: DB;
  adviceLlm: Parameters<typeof createOpportunityAdviceGenerator>[0];
  checkQuota(userId: string, estimatedCost: number): Promise<{ ok: boolean }>;
  parseProductDocument: ProductDocumentParser;
}

/** What follows a daily scan. Nothing here can reach a model: the acquisition service has no generator. */
export function createDailyScanFollowUp(db: Pick<DB, "pool">, opportunities: OpportunityService) {
  const acquisition = new CustomerAcquisitionService(db as DB);
  const settings = new EmployeeSettingsService(db.pool);
  const briefs = new BriefService(db.pool);
  const proposals = new ProposalService(db.pool, opportunities, acquisition);
  const today = new TodayService(db.pool, settings, opportunities, acquisition, proposals, briefs, new ScheduleService(db.pool));
  return async (userId: string, scan: { scanned: number; created: number }) => {
    await acquisition.seedRuleRecommendations(userId);
    const { items } = await today.get(userId);
    await briefs.write(userId, { ...scan, ...countToday(items), pending: items.length }, items.map((item) => item.id));
  };
}

export function registerDigitalEmployeeWorkerJobs({ queue, db, adviceLlm, checkQuota, parseProductDocument }: WorkerPorts) {
  const opportunities = new OpportunityService(db, undefined, createOpportunityAdviceGenerator(adviceLlm));
  const followUp = createDailyScanFollowUp(db, opportunities);
  queue.process("opportunity.discover", async (job) => {
    const { runId, useModel, daily } = job.input as { runId: string; useModel?: boolean; daily?: boolean };
    const result = await opportunities.runDiscovery(
      job.userId, runId, (value, stage) => queue.updateProgress(job.id, value, stage), { useModel }
    );
    // The scan itself succeeded; a missing brief must not make the job look failed.
    if (daily) {
      await followUp(job.userId, { scanned: result.candidates ?? 0, created: result.created ?? 0 })
        .catch((error) => console.warn(`[employee-brief] follow-up failed for user ${job.userId}:`, error));
    }
    return result;
  });
  const schedules = new ScheduleService(db.pool);
  const execution = { opportunities, checkQuota, generate: createScheduleReportGenerator(adviceLlm) };
  queue.process(SCHEDULE_JOB, async (job, control) => {
    const { runId } = job.input as { runId: string };
    return { status: await schedules.execute(job.userId, runId, execution, control.signal) };
  });
  const productDocuments = new ProductDocumentService(db.pool);
  queue.process(PRODUCT_DOCUMENT_JOB, async (job, control) => {
    const { documentId } = job.input as { documentId: string };
    await productDocuments.parse(job.userId, documentId, parseProductDocument, control.signal);
    return { documentId };
  });
}
