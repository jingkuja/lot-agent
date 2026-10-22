import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectMedia, composeMarketingVideo, detectedIntervals, mediaCapabilities, narrationPauses, qualityIssues } from "./media.js";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";

describe("marketing media safety", () => {
  it.each([59, 66])("rejects a %ds composition for a 60s target before opening media", async total => {
    const segments = Array.from({ length: 5 }, (_, index) => ({ index, script: "欢迎", durationSec: Math.floor(total / 5) + (index < total % 5 ? 1 : 0) }));
    await expect(composeMarketingVideo({ draft: MarketingDraftSchema.parse({ durationSec: 60 }), files: segments.map(() => "/missing.mp4"), segments })).rejects.toThrow("视频分段配置不完整");
  });
  it("rejects a disguised playlist before spawning a media decoder", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-media-test-"));
    try {
      const path = join(root, "fake.mp4");
      await writeFile(path, "#EXTM3U\n#EXTINF:15,\nfile:///etc/passwd");
      await expect(inspectMedia(path)).rejects.toThrow("素材格式");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("composed video quality checks", () => {
  it("pairs detector start and end values and closes an interval open at the end", () => {
    const output = "frame:0 pts:0 pts_time:0\nlavfi.black_start=0\nlavfi.black_end=1.52\nlavfi.freezedetect.freeze_start=4\nlavfi.freezedetect.freeze_duration=3\nlavfi.black_start=9.5\n";
    expect(detectedIntervals(output, "black_", 12)).toEqual([{ start: 0, end: 1.52 }, { start: 9.5, end: 12 }]);
    expect(detectedIntervals(output, "freezedetect.freeze_", 12)).toEqual([{ start: 4, end: 12 }]);
    expect(detectedIntervals("", "silence_", 12)).toEqual([]);
  });
  it("reports each issue in the shot it starts in and drops freezes inside black stretches", () => {
    expect(qualityIssues([
      { kind: "silence", start: 5.04, end: 7.91 },
      { kind: "black", start: 0, end: 1.52 },
      { kind: "freeze", start: 0.2, end: 1.4 },
      { kind: "freeze", start: 9, end: 12 },
      { kind: "black", start: 12, end: 12 },
    ], [5, 4, 3])).toEqual([
      { kind: "black", shot: 0, start: 0, end: 1.5 },
      { kind: "silence", shot: 1, start: 5, end: 7.9 },
      { kind: "freeze", shot: 2, start: 9, end: 12 },
    ]);
  });
});

describe("composition readiness probe", () => {
  const ffmpegInstalled = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
  it("rejects a program that only answers -version", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-probe-test-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fake = join(root, "fake-ffmpeg");
      await writeFile(fake, "#!/bin/sh\n[ \"$1\" = -version ] && echo 'ffmpeg version fake' && exit 0\nexit 0\n");
      await chmod(fake, 0o755);
      vi.stubEnv("MARKETING_FFMPEG_PATH", fake); vi.stubEnv("MARKETING_FFPROBE_PATH", fake);
      expect(await mediaCapabilities()).toEqual({ composition: false, subtitles: false });
      expect(warn).toHaveBeenCalledWith("[marketing-video] FFmpeg is missing composition features", { missing: expect.arrayContaining(["libx264", "aac", "amix"]) });
    } finally { vi.unstubAllEnvs(); warn.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(!ffmpegInstalled)("composes a probe clip with the installed FFmpeg", async () => {
    expect(await mediaCapabilities()).toMatchObject({ composition: true });
  }, 30_000);
  it.skipIf(!ffmpegInstalled)("replaces each clip's own audio with its narration and pads it to the shot", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-narration-compose-"));
    try {
      const clip = join(root, "clip.mp4"); const voice = join(root, "voice.wav");
      // A loud clip track that must not survive, and a quiet mono narration shorter than the shot.
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=5", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=24000", "-t", "2", voice]);
      const segments = [0, 1, 2].map(index => ({ index, script: "欢迎", durationSec: 5 }));
      const result = await composeMarketingVideo({ draft: MarketingDraftSchema.parse({ durationSec: 15 }), files: segments.map(() => clip), narration: segments.map(() => voice), speech: true, segments });
      const final = join(root, "final.mp4"); await writeFile(final, result.body);
      expect((await inspectMedia(final)).duration).toBeCloseTo(15, 0);
      const volume = spawnSync("ffmpeg", ["-v", "info", "-i", final, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
      expect(volume).toMatch(/max_volume: -(9[0-9]|inf)/);
      // Local checks only: the black, silent film is reported per shot, not rejected.
      expect(result.quality).toMatchObject({ checked: true, expectedSec: 15, subtitles: "model", speech: true });
      expect(result.quality.issues.map(issue => [issue.kind, issue.shot, issue.start])).toEqual([["black", 0, 0], ["silence", 0, 0]]);
      expect(result.quality.issues.every(issue => issue.end > 14.5)).toBe(true);
      await expect(composeMarketingVideo({ draft: MarketingDraftSchema.parse({ durationSec: 15 }), files: segments.map(() => clip), narration: segments.map(() => clip), segments })).rejects.toThrow("配音与镜头时长不一致");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
  it.skipIf(!ffmpegInstalled)("finds the pauses of a narration take", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-pauses-"));
    try {
      const voice = join(root, "voice.wav");
      // Tone 0–1s, silence 1–1.4s, tone 1.4–2.6s.
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-f", "lavfi", "-i", "sine=f=600:d=1.2",
        "-filter_complex", "[1]atrim=0:0.4[s];[0][s][2]concat=n=3:v=0:a=1", voice]);
      const pauses = await narrationPauses(voice, "wav", 2.6);
      expect(pauses).toHaveLength(1);
      expect(pauses[0].start).toBeCloseTo(1, 1);
      expect(pauses[0].end).toBeCloseTo(1.4, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
  // Needs FFmpeg with libass, e.g. MARKETING_FFMPEG_PATH pointing at the deployment image's FFmpeg.
  it.skipIf(!ffmpegInstalled)("burns each shot's captions while its narration is spoken", async ctx => {
    if (!(await mediaCapabilities()).subtitles) ctx.skip();
    const root = await mkdtemp(join(tmpdir(), "marketing-captions-"));
    try {
      const clip = join(root, "clip.mp4"); const voice = join(root, "voice.wav");
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=360x640:r=25:d=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=2", voice]);
      const segments = [0, 1, 2].map(index => ({ index, script: "欢迎光临 Price ¥19.9", durationSec: 5 }));
      const result = await composeMarketingVideo({ draft: MarketingDraftSchema.parse({ durationSec: 15 }), files: segments.map(() => clip), narration: segments.map(() => voice), subtitles: true, segments });
      const final = join(root, "final.mp4"); await writeFile(final, result.body);
      // Brightest pixel of the caption band: white text on the black clip while spoken, nothing after.
      const peak = (at: number) => Number(/YMAX=(\d+)/.exec(spawnSync("ffmpeg", ["-v", "error", "-ss", String(at), "-i", final, "-frames:v", "1",
        "-vf", "crop=iw:ih*0.2:0:ih*0.65,signalstats,metadata=mode=print:key=lavfi.signalstats.YMAX:file=-", "-f", "null", "-"], { encoding: "utf8" }).stdout)?.[1]);
      expect(peak(6)).toBeGreaterThan(200);
      expect(result.quality).toMatchObject({ subtitles: "burned", captions: 3 });
      expect(peak(9.5)).toBeLessThan(40);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);
});
