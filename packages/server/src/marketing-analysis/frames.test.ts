import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractAnalysisFrames, parseFrameLog } from "./frames.js";
import type { MediaRunner } from "./sandbox.js";

describe("source frame timestamps", () => {
  it("normalizes an offset timebase from source PTS, not the picture index", () => {
    const log = "config in time_base: 1/90000, frame_rate: 0/0\nn: 0 pts: 450000 pts_time:5 s:720x1280\nn: 1 pts: 499500 pts_time:5.55 s:720x1280\n";
    const frames = parseFrameLog(log, "a".repeat(64), "450000");
    expect(frames.map(f => f.ptsMs)).toEqual([0, 550]);
    expect(frames[1].sourcePts).toBe("499500");
    expect(() => parseFrameLog(log.replace("n: 1", "n: 4"), "a".repeat(64), "450000")).toThrow("INVALID_FRAME_TIMESTAMPS");
  });

  // External programs are an explicit integration test. Inputs are generated
  // here; the production runner ALWAYS uses a network-less Linux sandbox.
  it.skipIf(process.env.MARKETING_ANALYSIS_MEDIA_TEST !== "1")("extracts actual VFR/offset/rotated frames and detects a local change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lot-analysis-fixture-"));
    const exec = promisify(execFile);
    const runner: MediaRunner = { run: (command, args, signal) => exec(command, args.map(arg => arg.replaceAll("/work/", `${directory}/`)), { signal, maxBuffer: 8 * 1024 * 1024, timeout: 30000, env: { PATH: process.env.PATH, LC_ALL: "C" } }) };
    try {
      await runner.run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=20:d=4", "-vf", "drawbox=x=140:y=140:w=50:h=12:color=white:t=fill:enable='between(t,1,2)',select='if(lt(t,2),not(mod(n,2)),not(mod(n,3)))',setpts=PTS+5/TB", "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", "/work/base.mp4"]);
      try {
        await runner.run("ffmpeg", ["-v", "error", "-copyts", "-display_rotation", "90", "-i", "/work/base.mp4", "-c", "copy", "-y", "/work/source.mp4"]);
      } catch (error) {
        if (!String((error as { stderr?: string }).stderr).includes("Unrecognized option 'display_rotation'")) throw error;
        await runner.run("ffmpeg", ["-v", "error", "-copyts", "-i", "/work/base.mp4", "-c", "copy", "-metadata:s:v:0", "rotate=90", "-y", "/work/source.mp4"]);
      }
      const result = await extractAnalysisFrames({ directory, source: { platform: "douyin", canonicalUrl: "https://www.douyin.com/video/1234567", mediaKey: "source.mp4", sourceHash: "a".repeat(64) }, runner });
      expect(result.frames[0].ptsMs).toBe(0);
      expect(result.frames[0].sourcePts).not.toBe("0");
      expect(result.frames[0].width).toBeLessThan(result.frames[0].height);
      expect(result.frames.at(-1)?.ptsMs).toBeGreaterThan(3500);
      expect(result.frames.some(f => f.reasons.includes("change"))).toBe(true);
      expect(result.frames.some((f, i) => i && f.ptsMs - result.frames[i - 1].ptsMs !== 500)).toBe(true);
      await writeFile(join(directory, "source.mp4"), "#EXTM3U\nfile:///etc/passwd");
      await expect(extractAnalysisFrames({ directory, source: { platform: "douyin", canonicalUrl: "", mediaKey: "source.mp4", sourceHash: "a".repeat(64) }, runner })).rejects.toThrow("UNSUPPORTED_SOURCE");
      await runner.run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=160x90:r=10:d=2", "-vf", "setpts=PTS+190/TB", "-c:v", "libvpx-vp9", "-y", "/work/source.webm"]);
      const offset = await extractAnalysisFrames({ directory, source: { platform: "douyin", canonicalUrl: "", mediaKey: "source.webm", sourceHash: "b".repeat(64) }, runner });
      expect(offset.durationMs).toBe(2000);
      expect(offset.frames[0].sourcePts).toBe("190000");
      expect(offset.frames.at(-1)?.ptsMs).toBe(1900);
      // The decoded timeline still enforces the cap if metadata lies.
      const overlong: MediaRunner = { run: async (command, args, signal) => {
        const output = await runner.run(command, args, signal);
        if (command !== "ffprobe") return output;
        const probe = JSON.parse(output.stdout);
        probe.frames.at(-1).best_effort_timestamp = 380000;
        return { ...output, stdout: JSON.stringify(probe) };
      } };
      await expect(extractAnalysisFrames({ directory, source: { platform: "douyin", canonicalUrl: "", mediaKey: "source.webm", sourceHash: "b".repeat(64) }, runner: overlong })).rejects.toThrow("DURATION_LIMIT");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30000);
});
