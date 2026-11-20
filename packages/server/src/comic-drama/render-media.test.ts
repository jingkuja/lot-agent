import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMIC_RENDER_MAX_INPUTS, comicTimelineSchema, layoutComicTimeline } from "@lot-agent/core/comic-drama";
import { ffmpeg, inspectMedia, mediaCapabilities, mediaProcess } from "../marketing-video/media.js";
import {
  COMIC_RENDER_PREMIX_BATCH, composeComicRender, planAudioStemPremix, shouldPremixComicAudio, type PremixClipEntry,
} from "./render-media.js";

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
});
