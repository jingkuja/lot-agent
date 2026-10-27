import { z } from "zod";
import type { MarketingDraft } from "../marketing-video/index.js";

export const ANALYSIS_VERSION = "frames-v1";
export const ANALYSIS_LIMITS = Object.freeze({ durationMs: 180_000, downloadBytes: 100 * 1024 * 1024, temporaryBytes: 512 * 1024 * 1024, candidates: 361, ocrImages: 120, visualImages: 48, batchImages: 6, requestBytes: 24 * 1024 * 1024 });
/** Formats of a local video uploaded for analysis; the browser checks them before upload. */
export const ANALYSIS_UPLOAD_MIMES: readonly string[] = ["video/mp4", "video/quicktime", "video/webm"];
export const AnalysisPlatformSchema = z.enum(["douyin", "xiaohongshu", "bilibili"]);
export type AnalysisPlatform = z.infer<typeof AnalysisPlatformSchema>;
const ms = z.number().int().min(0).max(ANALYSIS_LIMITS.durationMs);
const frameId = z.string().regex(/^f\d{4}$/);
const evidenceId = z.string().regex(/^(?:[ft]\d{4}|a0001)$/);
export const FrameEvidenceSchema = z.object({
  id: frameId, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourcePts: z.string().regex(/^-?\d+$/), timeBase: z.string().regex(/^[1-9]\d*\/[1-9]\d*$/), ptsMs: ms,
  width: z.number().int().positive().max(1920), height: z.number().int().positive().max(1920),
  objectKey: z.string().max(200), reasons: z.array(z.enum(["start", "end", "periodic", "change", "before_change", "scene"])).max(6),
}).strict();
export type FrameEvidence = z.infer<typeof FrameEvidenceSchema>;
export const FrameTextSchema = z.object({ frameId, rawText: z.string().max(6000) }).strict();
export type FrameText = z.infer<typeof FrameTextSchema>;
export const OcrOutputSchema = z.object({ text: z.string().max(6000) }).strict();
export const VisualOutputSchema = z.object({ observations: z.array(z.unknown()).max(12) }).strict();
export const ScreenTextSchema = z.object({
  id: z.string().regex(/^t\d{4}$/), rawText: z.string().min(1).max(6000), text: z.string().max(6000),
  frameIds: z.array(frameId).min(1).max(120), firstSeenMs: ms, lastSeenMs: ms,
}).strict().refine(t => t.firstSeenMs <= t.lastSeenMs);
export type ScreenText = z.infer<typeof ScreenTextSchema>;
export const ObservationSchema = z.object({
  description: z.string().min(1).max(2000), frameIds: z.array(frameId).min(1).max(7),
  uncertainty: z.string().max(1000),
}).strict();
export type VisualObservation = z.infer<typeof ObservationSchema>;
const finding = z.object({ statement: z.string().min(1).max(2000), evidenceIds: z.array(evidenceId).min(1).max(30), inference: z.boolean() }).strict();
export const AnalysisSummarySchema = z.object({
  summary: z.array(finding).max(12),
  timeline: z.array(z.object({ startMs: ms, endMs: ms, ...finding.shape }).strict().refine(t => t.startMs <= t.endMs)).max(48),
  marketingPoints: z.array(z.object({ kind: z.enum(["hook", "selling_point", "demonstration", "cta"]), ...finding.shape }).strict()).max(20),
  limitations: z.array(z.string().min(1).max(1000)).max(20),
}).strict();
export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;
export interface AnalysisCoverage {
  sampledFrames: number; ocrFrames: number; visualFrames: number;
  omittedOcrFrameIds: string[]; omittedVisualFrameIds: string[];
  limitations: string[];
}
export interface AnalysisSource {
  platform: AnalysisPlatform | "local"; canonicalUrl: string; canonicalId?: string; selectedPart?: number; uploadId?: string;
  title?: string; author?: string; durationMs?: number; sourceHash?: string; mediaKey?: string; downloaderVersion?: string;
}
export type AnalysisStatus = "queued" | "running" | "needs_auth" | "needs_review" | "partial" | "ready" | "failed" | "cancelled";
export type AnalysisSpeech = { status: "completed"; id: "a0001"; text: string; model: string }
  | { status: "skipped"; reason: "ASR_MODEL_UNAVAILABLE" | "NO_AUDIO_TRACK" | "SOURCE_EXPIRED" };
export interface AnalysisSnapshot {
  speech?: AnalysisSpeech;
  source: AnalysisSource; frames: FrameEvidence[]; frameTexts: FrameText[]; texts: ScreenText[];
  creation?: { draft: MarketingDraft; analysis: string };
  completedVisualBatches?: number[];
  observations: VisualObservation[]; summary?: AnalysisSummary; summaryRevision?: number; coverage?: AnalysisCoverage;
}
export interface ReferenceAnalysis {
  id: string; ownerId: string; taskId: string; revision: number; version: number; status: AnalysisStatus;
  stage: string; errorCode?: string; snapshot: AnalysisSnapshot; createdAt: string; updatedAt: string;
  projectId?: string; applied?: boolean; pendingCalls?: number;
}
export const CreateAnalysisSchema = z.object({ shareText: z.string().trim().min(1).max(4000).optional(), uploadId: z.string().uuid().optional(), clientRequestId: z.string().uuid(),
  target: z.object({ projectId: z.string().uuid(), projectVersion: z.number().int().positive(), locale: z.enum(["zh", "en", "id"]) }).strict().optional(),
}).strict().refine(value => !!value.shareText !== !!value.uploadId, { message: "Choose one analysis source" });
export interface AnalysisStore {
  get(ownerId: string, id: string): Promise<ReferenceAnalysis | null>;
}
export interface AnalysisQueue {
  deliver(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
}
export interface AnalysisUsage { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }
/** `cancelled`: the gateway returned nothing (error status, timeout, lost connection), so the call is
 * treated as not charged and may be retried; `gatewayRequestId` matches a rare charge in the gateway logs. */
export interface ModelStepReceipt {
  text: string; usage?: AnalysisUsage; responseId?: string; gatewayRequestId?: string;
  outcome: "completed" | "failed" | "request_unknown" | "rejected" | "cancelled";
  errorCode?: string;
}
/** begin() must atomically claim the durable request intent.
 * Existing unknown intents may not trigger another paid request. */
export interface AnalysisCallLedger {
  begin(stepId: string, inputHash: string, model: string, imageCount: number): Promise<ModelStepReceipt | null>;
  finish(stepId: string, receipt: ModelStepReceipt): Promise<void>;
  responseId?(stepId: string, id: string): Promise<void>;
  /** The gateway's log ID (`x-oneapi-request-id`), saved as soon as the response headers arrive. */
  requestId?(stepId: string, id: string): Promise<void>;
  /** The model already recorded for the step; a replay or explicit retry must use it again. */
  stepModel?(stepId: string): Promise<string | undefined>;
}
export interface AnalysisLease { id: string; ownerId: string; token: string; revision: number }
export interface AnalysisJobStore extends AnalysisStore {
  claim(id: string): Promise<AnalysisLease | null>;
  heartbeat(lease: AnalysisLease): Promise<boolean>;
  checkpoint(lease: AnalysisLease, snapshot: AnalysisSnapshot, stage: string, selection?: unknown): Promise<void>;
  finish(lease: AnalysisLease, errorCode?: string): Promise<void>;
  cancel(ownerId: string, id: string): Promise<ReferenceAnalysis | null>;
  resume(ownerId: string, id: string, revision: number, visualOnly?: boolean): Promise<ReferenceAnalysis | null>;
  remove(ownerId: string, id: string): Promise<void>;
}
export * from "./evidence.js";
export * from "./sampling.js";
