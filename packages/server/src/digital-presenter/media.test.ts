import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectMedia } from "../marketing-video/media.js";
import { readImageInfo } from "../marketing-video/image-size.js";
import { buildTrack, composeImageMode, composeVideoMode, footageScale, portraitFrame, prepareFootage, preparePortrait } from "./media.js";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;
let dir: string;
const run = (...args: string[]) => { const result = spawnSync("ffmpeg", ["-nostdin", "-y", "-v", "error", ...args], { cwd: dir }); if (result.status) throw new Error(String(result.stderr)); };

describe("presenter frame and footage limits", () => {
  it("sizes the portrait frame by ratio and resolution", () => {
    expect(portraitFrame("9:16", "720P")).toEqual({ width: 720, height: 1280 });
    expect(portraitFrame("16:9", "480P")).toEqual({ width: 854, height: 480 });
    expect(portraitFrame("1:1", "720P")).toEqual({ width: 720, height: 720 });
  });
  it("scales footage into VideoRetalk's 640–2048 px edges", () => {
    expect(footageScale(1080, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(footageScale(480, 854)).toEqual({ width: 640, height: 1138 });
    expect(footageScale(2160, 3840)).toEqual({ width: 1152, height: 2048 });
    expect(footageScale(300, 1200)).toBeNull();
  });
});

describe.skipIf(!ffmpegAvailable)("presenter media with FFmpeg", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "presenter-media-"));
    run("-f", "lavfi", "-i", "color=c=blue:s=1000x800", "-frames:v", "1", "portrait.png");
    run("-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-ar", "24000", "take0.wav");
    run("-f", "lavfi", "-i", "sine=frequency=660:duration=0.8", "-ar", "24000", "take1.wav");
    run("-f", "lavfi", "-i", "color=c=red:s=480x854:r=10:d=3", "-f", "lavfi", "-i", "sine=duration=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "footage.mp4");
    run("-f", "lavfi", "-i", "color=c=green:s=720x1280:r=16:d=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "clip0.mp4");
    run("-f", "lavfi", "-i", "color=c=green:s=720x1280:r=16:d=0.8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "clip1.mp4");
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("crops the portrait to the chosen ratio", async () => {
    await preparePortrait(join(dir, "portrait.png"), join(dir, "portrait.jpg"), "9:16");
    expect(await readImageInfo(join(dir, "portrait.jpg"))).toMatchObject({ mime: "image/jpeg", width: 720, height: 1280 });
  });

  it("joins takes with a pause and trims silent footage to the track", async () => {
    const seconds = await buildTrack([join(dir, "take0.wav"), join(dir, "take1.wav")], join(dir, "track.wav"));
    expect(seconds).toBeCloseTo(2.25, 1);
    const footage = await prepareFootage(join(dir, "footage.mp4"), join(dir, "prepared.mp4"), seconds);
    expect(footage).toMatchObject({ video: true, audio: false, width: 640, height: 1138 });
    expect(footage.duration).toBeCloseTo(seconds, 0);
    expect(Math.round(footage.fps)).toBe(30);
    await expect(prepareFootage(join(dir, "footage.mp4"), join(dir, "short.mp4"), 5)).rejects.toThrow("不短于配音");
  });

  it("composes image-mode clips with their takes and video-mode footage with the track", async () => {
    const image = await composeImageMode({ clips: [join(dir, "clip0.mp4"), join(dir, "clip1.mp4")], takes: [join(dir, "take0.wav"), join(dir, "take1.wav")], takeMs: [1200, 800], frame: { width: 720, height: 1280 } });
    expect(image).toMatchObject({ width: 720, height: 1280 });
    expect(image.durationSec).toBeCloseTo(2.25, 0);
    const video = await composeVideoMode({ clip: join(dir, "prepared.mp4"), track: join(dir, "track.wav"), trackSec: 2.25 });
    expect(video.durationSec).toBeCloseTo(2.25, 0);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "final.mp4"), video.body);
    expect(await inspectMedia(join(dir, "final.mp4"))).toMatchObject({ video: true, audio: true });
  });
});
