import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { COMIC_RENDER_MAX_INPUTS, comicTimelineSchema, layoutComicTimeline } from "@lot-agent/core/comic-drama";
import { ffmpeg, inspectMedia, mediaCapabilities, mediaProcess } from "../marketing-video/media.js";
import {
  COMIC_RENDER_PREMIX_BATCH, ComicRenderFailure, composeComicRender, estimateComicRenderTempBytes, isHighSpecVideoSource,
  planAudioStemPremix, shouldPremixComicAudio, shouldPretranscodeComicVideo, type PremixClipEntry,
} from "./render-media.js";
import {
  checkDiskFreeSpace, cleanupComicOrphanTempDirs, registerActiveComicTempDir, unregisterActiveComicTempDir,
} from "./temp-cleanup.js";

const uuid = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;

describe("comic render audio stem premixing", () => {
  it("triggers premixing when total inputs exceed 64 and bounds every FFmpeg pass", () => {
    const video = Array.from({ length: 40 }, (_, i) => ({
      id: uuid(10 + i), takeId: uuid(100 + i), sourceDurationMs: 6000, inMs: 0, outMs: 6000,
      volume: 1, transitionIn: { kind: "cut" as const, durationMs: 0 as const },
    }));
    const voice = video.flatMap((clip, i) => [0, 1].map(slot => ({
      id: uuid(200 + i * 2 + slot), mediaId: uuid(400 + i * 2 + slot),
      anchor: { kind: "clip" as const, videoItemId: clip.id, offsetMs: slot * 2000 },
      durationMs: 1500, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
    })));
    const timeline = comicTimelineSchema.parse({
      schemaVersion: 1, aspectRatio: "9:16", video, voice, sfx: [], music: [], subtitles: [],
    });
    expect(shouldPremixComicAudio(timeline)).toBe(true);

    const layout = layoutComicTimeline(timeline);
    const entries: PremixClipEntry[] = timeline.voice.map((clip, index) => ({
      path: `/tmp/voice-${index}.wav`, format: "wav", sourceDurationMs: 2000, startMs: layout.voice[index].startMs, clip,
    }));
    const plan = planAudioStemPremix("voice", entries, "240.000000");
    // 80 items in batches of 32 -> 3 chunk passes (32, 32, 16) + 1 merge pass (3) = 4 passes.
    expect(plan.passes.length).toBe(4);
    expect(plan.finalStem).toBe("stem-voice.wav");
    expect(plan.passes.every(pass => pass.inputCount <= COMIC_RENDER_PREMIX_BATCH)).toBe(true);
    expect(plan.passes.every(pass => pass.args.includes("pcm_f32le"))).toBe(true);
    expect(plan.passes.at(-1)?.output).toBe("stem-voice.wav");
    // Final render pass combines 40 video clips + 1 premixed voice stem = 41 <= 64.
    expect(timeline.video.length + 1).toBeLessThanOrEqual(COMIC_RENDER_MAX_INPUTS);
  });

  it("keeps small timelines on single-pass composition and uses one premix pass when track <= batch size", () => {
    const timeline = comicTimelineSchema.parse({
      schemaVersion: 1, aspectRatio: "9:16",
      video: [{
        id: uuid(1), takeId: uuid(2), sourceDurationMs: 6000, inMs: 0, outMs: 6000,
        volume: 1, transitionIn: { kind: "cut", durationMs: 0 },
      }],
      voice: [{
        id: uuid(3), mediaId: uuid(4), anchor: { kind: "timeline", offsetMs: 500 }, durationMs: 1000,
        sourceInMs: 0, volume: 1, fadeInMs: 100, fadeOutMs: 100, loop: false,
      }],
      sfx: [], music: [], subtitles: [],
    });
    expect(shouldPremixComicAudio(timeline)).toBe(false);
    const plan = planAudioStemPremix("voice", [{
      path: "/tmp/a.wav", format: "wav", sourceDurationMs: 1500, startMs: 500, clip: timeline.voice[0],
    }], "6.000000");
    expect(plan.passes).toHaveLength(1);
    expect(plan.passes[0].output).toBe("stem-voice.wav");
    expect(plan.passes[0].args.join(" ")).toContain("afade=t=in:d=0.100000");
    expect(plan.passes[0].args.join(" ")).toContain("adelay=24000S:all=1");
  });

  it("composes a >64-input timeline end-to-end via staged FFmpeg audio stem premixing", async () => {
    const caps = await mediaCapabilities();
    if (!caps.composition) return;
    const folder = await mkdtemp(join(tmpdir(), "lot-comic-premix-test-"));
    try {
      const videoPath = join(folder, "clip.mp4");
      const wavPath = join(folder, "tone.wav");
      await mediaProcess(ffmpeg(), [
        "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0x224466:s=320x568:r=30:d=4",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-threads", "1", videoPath,
      ], { timeoutMs: 20_000 });
      await mediaProcess(ffmpeg(), [
        "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=48000:duration=0.2",
        "-c:a", "pcm_s16le", wavPath,
      ], { timeoutMs: 10_000 });
      const videoInfo = await inspectMedia(videoPath);
      const audioInfo = await inspectMedia(wavPath);
      const videoDurationMs = Math.round(videoInfo.duration * 1000);
      const audioDurationMs = Math.round(audioInfo.duration * 1000);
      const takeId = uuid(700);
      const audioId = uuid(701);
      const voice = Array.from({ length: 68 }, (_, i) => ({
        id: uuid(800 + i), mediaId: audioId,
        anchor: { kind: "timeline" as const, offsetMs: i * 50 },
        durationMs: audioDurationMs, sourceInMs: 0, volume: 0.2, fadeInMs: 0, fadeOutMs: 0, loop: false,
      }));
      const timeline = comicTimelineSchema.parse({
        schemaVersion: 1, aspectRatio: "9:16",
        video: [{
          id: uuid(710), takeId, sourceDurationMs: videoDurationMs, inMs: 0, outMs: videoDurationMs,
          volume: 1, transitionIn: { kind: "cut", durationMs: 0 },
        }],
        voice, sfx: [], music: [], subtitles: [],
      });
      expect(shouldPremixComicAudio(timeline)).toBe(true);
      const rendered = await composeComicRender(
        timeline,
        {
          videos: new Map([[takeId, { path: videoPath, durationMs: videoDurationMs }]]),
          audio: new Map([[audioId, { path: wavPath, durationMs: audioDurationMs }]]),
        },
        AbortSignal.timeout(60_000),
      );
      try {
        const out = await inspectMedia(rendered.file);
        expect(out.video).toBe(true);
        expect(out.audio).toBe(true);
        expect(Math.abs(out.duration * 1000 - videoDurationMs)).toBeLessThanOrEqual(34);
      } finally {
        await rendered.dispose();
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);

  it("P2 #11: mutes original clip audio in FFmpeg export when clip volume is 0", async () => {
    const caps = await mediaCapabilities();
    if (!caps.composition) return;
    const folder = await mkdtemp(join(tmpdir(), "lot-comic-mute-test-"));
    try {
      const videoPath = join(folder, "loud.mp4");
      await mediaProcess(ffmpeg(), [
        "-nostdin", "-v", "error",
        "-f", "lavfi", "-i", "color=c=0x112233:s=320x568:r=30:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest", "-threads", "1", videoPath,
      ], { timeoutMs: 20_000 });
      const info = await inspectMedia(videoPath);
      expect(info.audio).toBe(true);
      const durationMs = Math.round(info.duration * 1000);
      const takeId = uuid(901);
      const timeline = comicTimelineSchema.parse({
        schemaVersion: 1, aspectRatio: "9:16",
        video: [{
          id: uuid(902), takeId, sourceDurationMs: durationMs, inMs: 0, outMs: durationMs,
          volume: 0, transitionIn: { kind: "cut", durationMs: 0 },
        }],
        voice: [], sfx: [], music: [], subtitles: [],
      });
      const rendered = await composeComicRender(
        timeline,
        { videos: new Map([[takeId, { path: videoPath, durationMs }]]), audio: new Map() },
        AbortSignal.timeout(30_000),
      );
      try {
        const execFileAsync = promisify(execFile);
        const probe = await execFileAsync(ffmpeg(), [
          "-nostdin", "-i", rendered.file, "-af", "volumedetect", "-f", "null", "-",
        ], { timeout: 15_000 });
        const maxVolMatch = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(probe.stderr);
        expect(maxVolMatch).toBeTruthy();
        expect(Number(maxVolMatch![1])).toBeLessThanOrEqual(-80);
      } finally {
        await rendered.dispose();
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 45_000);

  it("P1: exports all-24fps natively at 24fps, converts mixed 24+30fps to CFR 30fps, and runs segmented pre-transcoding with disk guard", async () => {
    expect(isHighSpecVideoSource({ width: 2160, height: 3840, videoCodec: "hevc", pixFmt: "yuv420p10le" })).toBe(true);
    expect(isHighSpecVideoSource({ width: 1080, height: 1920, videoCodec: "h264", pixFmt: "yuv420p" })).toBe(false);
    expect(estimateComicRenderTempBytes(300_000, true, 1_073_741_824)).toBeGreaterThan(1_500_000_000);

    const caps = await mediaCapabilities();
    if (!caps.composition) return;
    const folder = await mkdtemp(join(tmpdir(), "lot-comic-p1-render-"));
    try {
      const clip24a = join(folder, "a-24.mp4");
      const clip24b = join(folder, "b-24.mp4");
      const clip30 = join(folder, "c-30.mp4");
      await mediaProcess(ffmpeg(), [
        "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0x224466:s=320x568:r=24:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-threads", "1", clip24a,
      ], { timeoutMs: 20_000 });
      await mediaProcess(ffmpeg(), [
        "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0x883322:s=320x568:r=24:d=2",
        "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-threads", "1", clip24b,
      ], { timeoutMs: 20_000 });
      await mediaProcess(ffmpeg(), [
        "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0x337744:s=320x568:r=30:d=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-threads", "1", clip30,
      ], { timeoutMs: 20_000 });

      const info24a = await inspectMedia(clip24a);
      const info24b = await inspectMedia(clip24b);
      const info30 = await inspectMedia(clip30);
      const d24a = Math.round(info24a.duration * 1000);
      const d24b = Math.round(info24b.duration * 1000);
      const d30 = Math.round(info30.duration * 1000);

      // 1. All-24fps timeline with crossfade + forcePretranscode -> native 24fps & heartbeat invoked
      const t24a = uuid(950), t24b = uuid(951);
      const timeline24 = comicTimelineSchema.parse({
        schemaVersion: 1, aspectRatio: "9:16",
        video: [
          { id: uuid(952), takeId: t24a, sourceDurationMs: d24a, inMs: 0, outMs: d24a, volume: 1, transitionIn: { kind: "cut", durationMs: 0 } },
          { id: uuid(953), takeId: t24b, sourceDurationMs: d24b, inMs: 0, outMs: d24b, volume: 1, transitionIn: { kind: "crossfade", durationMs: 500 } },
        ],
        voice: [], sfx: [], music: [], subtitles: [],
      });
      expect(shouldPretranscodeComicVideo(timeline24, new Map([
        [t24a, { info: { width: 2160, height: 3840, videoCodec: "hevc", pixFmt: "yuv420p10le" } }],
        [t24b, { info: { width: 2160, height: 3840, videoCodec: "hevc", pixFmt: "yuv420p10le" } }],
      ]))).toBe(true);

      // Disk space guard rejects before render when free space is below threshold.
      const lowStatfs = (async () => ({ bavail: 100, bsize: 4096 })) as unknown as Parameters<typeof checkDiskFreeSpace>[2];
      await expect(composeComicRender(timeline24, {
        videos: new Map([[t24a, { path: clip24a, durationMs: d24a }], [t24b, { path: clip24b, durationMs: d24b }]]),
        audio: new Map(),
      }, AbortSignal.timeout(30_000), { statfs: lowStatfs })).rejects.toMatchObject({ errorCode: "RENDER_DISK_SPACE_LOW" });
      expect(new ComicRenderFailure("RENDER_DISK_SPACE_LOW").errorCode).toBe("RENDER_DISK_SPACE_LOW");

      let heartbeats = 0;
      const out24 = await composeComicRender(timeline24, {
        videos: new Map([[t24a, { path: clip24a, durationMs: d24a }], [t24b, { path: clip24b, durationMs: d24b }]]),
        audio: new Map(),
      }, AbortSignal.timeout(60_000), { fpsMode: "auto", forcePretranscode: true, onHeartbeat: () => { heartbeats += 1; } });
      try {
        expect(out24.outputFps).toBe(24);
        expect(out24.fpsPolicy).toBe("native");
        expect(out24.pretranscoded).toBe(true);
        expect(heartbeats).toBeGreaterThanOrEqual(4);
        const probed = await inspectMedia(out24.file);
        expect(Math.abs(probed.fps - 24)).toBeLessThanOrEqual(0.15);
        expect(Math.abs(probed.duration * 1000 - (d24a + d24b - 500))).toBeLessThanOrEqual(42);
      } finally {
        await out24.dispose();
      }

      // 2. Mixed 24fps + 30fps timeline -> CFR 30fps
      const t30 = uuid(954);
      const mixedTimeline = comicTimelineSchema.parse({
        schemaVersion: 1, aspectRatio: "9:16",
        video: [
          { id: uuid(955), takeId: t24a, sourceDurationMs: d24a, inMs: 0, outMs: d24a, volume: 1, transitionIn: { kind: "cut", durationMs: 0 } },
          { id: uuid(956), takeId: t30, sourceDurationMs: d30, inMs: 0, outMs: d30, volume: 1, transitionIn: { kind: "cut", durationMs: 0 } },
        ],
        voice: [], sfx: [], music: [], subtitles: [],
      });
      const outMixed = await composeComicRender(mixedTimeline, {
        videos: new Map([[t24a, { path: clip24a, durationMs: d24a }], [t30, { path: clip30, durationMs: d30 }]]),
        audio: new Map(),
      }, AbortSignal.timeout(60_000), { fpsMode: "auto" });
      try {
        expect(outMixed.outputFps).toBe(30);
        expect(outMixed.fpsPolicy).toBe("cfr_convert");
        expect(outMixed.mixedSourceFps).toBe(true);
        const probed = await inspectMedia(outMixed.file);
        expect(Math.abs(probed.fps - 30)).toBeLessThanOrEqual(0.15);
      } finally {
        await outMixed.dispose();
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);

  it("P1: cleans aged orphan render/upload temp dirs while protecting fresh and active dirs", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "lot-comic-cleanup-test-"));
    const tempRoot = join(sandbox, "tmp");
    const mediaRoot = join(sandbox, "media");
    await mkdir(tempRoot, { recursive: true });
    await mkdir(mediaRoot, { recursive: true });
    try {
      const oldRender = join(tempRoot, "lot-comic-render-old");
      const freshRender = join(tempRoot, "lot-comic-render-fresh");
      const activeRender = join(tempRoot, "lot-comic-render-active");
      const unrelated = join(tempRoot, "other-dir");
      const oldUpload = join(mediaRoot, ".upload-old");
      for (const dir of [oldRender, freshRender, activeRender, unrelated, oldUpload]) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "part.bin"), Buffer.alloc(1024, 1));
      }
      const now = Date.now();
      const threeHoursAgo = new Date(now - 3 * 60 * 60_000);
      for (const dir of [oldRender, activeRender, oldUpload]) {
        await utimes(join(dir, "part.bin"), threeHoursAgo, threeHoursAgo);
        await utimes(dir, threeHoursAgo, threeHoursAgo);
      }
      registerActiveComicTempDir(activeRender);
      try {
        const res = await cleanupComicOrphanTempDirs({ tempRoot, mediaRoot, maxAgeMs: 2 * 60 * 60_000, nowMs: now });
        expect(res.removed).toBe(2);
        expect(res.skippedActive).toBe(1);
        expect(res.reclaimedBytes).toBeGreaterThanOrEqual(2048);
        await expect(stat(oldRender)).rejects.toThrow();
        await expect(stat(oldUpload)).rejects.toThrow();
        await expect(stat(freshRender)).resolves.toBeTruthy();
        await expect(stat(activeRender)).resolves.toBeTruthy();
        await expect(stat(unrelated)).resolves.toBeTruthy();
      } finally {
        unregisterActiveComicTempDir(activeRender);
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("renders ephemeral preview mode at 540x960 for 9:16 with valid H.264 + AAC and matching duration", async () => {
    const caps = await mediaCapabilities();
    if (!caps.composition) return;
    const folder = await mkdtemp(join(tmpdir(), "lot-comic-preview-test-"));
    try {
      const videoPath = join(folder, "src.mp4");
      await mediaProcess(ffmpeg(), [
        "-nostdin", "-v", "error",
        "-f", "lavfi", "-i", "color=c=0x224466:s=720x1280:r=30:d=2",
        "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", "-threads", "1", videoPath,
      ], { timeoutMs: 20_000 });
      const info = await inspectMedia(videoPath);
      const durationMs = Math.round(info.duration * 1000);
      const takeId = uuid(991);
      const timeline = comicTimelineSchema.parse({
        schemaVersion: 1, aspectRatio: "9:16",
        video: [{
          id: uuid(992), takeId, sourceDurationMs: durationMs, inMs: 0, outMs: durationMs,
          volume: 1, transitionIn: { kind: "cut", durationMs: 0 },
        }],
        voice: [], sfx: [], music: [], subtitles: [],
      });
      const rendered = await composeComicRender(
        timeline,
        { videos: new Map([[takeId, { path: videoPath, durationMs }]]), audio: new Map() },
        AbortSignal.timeout(30_000),
        { preview: true },
      );
      try {
        const out = await inspectMedia(rendered.file);
        expect(out.video).toBe(true);
        expect(out.audio).toBe(true);
        expect(out.width).toBe(540);
        expect(out.height).toBe(960);
        expect(Math.abs(out.duration * 1000 - durationMs)).toBeLessThanOrEqual(34);
      } finally {
        await rendered.dispose();
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 45_000);
});
