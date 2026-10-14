import { describe, expect, it } from "vitest";
import { analysisMediaRuntime } from "./media-runtime.js";
import { isolatedMediaRunner } from "./sandbox.js";
import { localProbeDownloadRuntime, localProbeRunner } from "./local-probe.js";

describe("Worker media isolation selection", () => {
  it("keeps Linux isolation by default, including on a Mac", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const runtime = analysisMediaRuntime({}, platform);
      expect(runtime.downloadRuntime).toBeUndefined();
      expect(runtime.decoderRunner).toBe(isolatedMediaRunner);
    }
  });

  it("selects both isolated macOS stages only after explicit development opt-in", () => {
    const runtime = analysisMediaRuntime({ MARKETING_ANALYSIS_MACOS_SANDBOX: "1", NODE_ENV: "development" }, "darwin");
    expect(runtime.downloadRuntime).toBe(localProbeDownloadRuntime);
    expect(runtime.decoderRunner).toBe(localProbeRunner);
  });

  it.each([
    ["darwin", "production", "1"],
    ["linux", "development", "1"],
    ["win32", "development", "1"],
    ["darwin", "development", "disabled"],
  ] as const)("rejects incompatible configuration (%s, %s, %s)", (platform, nodeEnv, flag) => {
    expect(() => analysisMediaRuntime({ MARKETING_ANALYSIS_MACOS_SANDBOX: flag, NODE_ENV: nodeEnv }, platform)).toThrow("SANDBOX_REQUIRED");
  });

  it("allows the explicitly disabled switch in production", () => {
    expect(analysisMediaRuntime({ MARKETING_ANALYSIS_MACOS_SANDBOX: "0", NODE_ENV: "production" }, "linux").decoderRunner).toBe(isolatedMediaRunner);
  });
});
