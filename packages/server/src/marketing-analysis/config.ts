import { AnalysisError } from "./errors.js";

export const ANALYSIS_QUEUE = "lot-media-analysis";
export const ANALYSIS_JOB = "marketing.analysis";
/** Hard limit for one run (from claim to finish). The page expects about 5 minutes; a run cut off here keeps its
 * completed steps and ends resumable with ANALYSIS_TIMEOUT. */
export const ANALYSIS_RUN_LIMIT_MS = 10 * 60_000;
export interface AnalysisParallelism {
  ocrConcurrency: number; visualConcurrency: number; decodeThreads: number;
}
export function analysisParallelism(input: Partial<AnalysisParallelism> = {}): AnalysisParallelism {
  const value = { ocrConcurrency: input.ocrConcurrency ?? 8, visualConcurrency: input.visualConcurrency ?? 3, decodeThreads: input.decodeThreads ?? 4 };
  for (const [key, maximum] of [["ocrConcurrency", 16], ["visualConcurrency", 4], ["decodeThreads", 8]] as const) {
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > maximum) throw new AnalysisError("ANALYSIS_CONFIG_REQUIRED", 503);
  }
  return value;
}
export interface AnalysisConfig extends AnalysisParallelism {
  enabled: boolean; downloaderVersion: string; concurrency: number;
}
/** The gateway owns balance checks and billing; no local price configuration. */
export function analysisConfig(env: NodeJS.ProcessEnv = process.env): AnalysisConfig {
  if (env.MARKETING_ANALYSIS_ENABLED !== "1") return { enabled: false, downloaderVersion: "", concurrency: 1, ...analysisParallelism() };
  const concurrency = Number(env.MARKETING_ANALYSIS_CONCURRENCY ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4
    || !/^\d{4}\.\d{2}\.\d{2}$/.test(env.YTDLP_VERSION ?? "") || !env.SECRET_MASTER_KEY) throw new AnalysisError("ANALYSIS_CONFIG_REQUIRED", 503);
  const parallelism = analysisParallelism({ ocrConcurrency: Number(env.MARKETING_ANALYSIS_OCR_CONCURRENCY ?? 8),
    visualConcurrency: Number(env.MARKETING_ANALYSIS_VISUAL_CONCURRENCY ?? 3), decodeThreads: Number(env.MARKETING_ANALYSIS_DECODE_THREADS ?? 4) });
  return { enabled: true, downloaderVersion: env.YTDLP_VERSION!, concurrency, ...parallelism };
}
