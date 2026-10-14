import { AnalysisError } from "./errors.js";

export const ANALYSIS_QUEUE = "lot-media-analysis";
export const ANALYSIS_JOB = "marketing.analysis";
export interface AnalysisConfig {
  enabled: boolean; downloaderVersion: string; concurrency: number;
}
/** The gateway owns balance checks and billing; no local price configuration. */
export function analysisConfig(env: NodeJS.ProcessEnv = process.env): AnalysisConfig {
  if (env.MARKETING_ANALYSIS_ENABLED !== "1") return { enabled: false, downloaderVersion: "", concurrency: 1 };
  const concurrency = Number(env.MARKETING_ANALYSIS_CONCURRENCY ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4
    || !/^\d{4}\.\d{2}\.\d{2}$/.test(env.YTDLP_VERSION ?? "") || !env.SECRET_MASTER_KEY) throw new AnalysisError("ANALYSIS_CONFIG_REQUIRED", 503);
  return { enabled: true, downloaderVersion: env.YTDLP_VERSION!, concurrency };
}
