import { AnalysisError } from "./errors.js";
import { localProbeDownloadRuntime, localProbeRunner } from "./local-probe.js";
import { isolatedMediaRunner, type MediaRunner } from "./sandbox.js";
import type { AnalysisDownloadRuntime } from "./download.js";

export interface AnalysisMediaRuntime {
  downloadRuntime?: (directory: string, signal: AbortSignal) => Promise<AnalysisDownloadRuntime>;
  decoderRunner(directory: string): MediaRunner;
}

/** Worker-owned choice only. HTTP requests cannot select or disable isolation. */
export function analysisMediaRuntime(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): AnalysisMediaRuntime {
  const macos = env.MARKETING_ANALYSIS_MACOS_SANDBOX;
  if (!macos || macos === "0") return { decoderRunner: isolatedMediaRunner };
  if (macos !== "1" || platform !== "darwin" || env.NODE_ENV === "production") {
    throw new AnalysisError("SANDBOX_REQUIRED", 503);
  }
  return { downloadRuntime: localProbeDownloadRuntime, decoderRunner: localProbeRunner };
}
