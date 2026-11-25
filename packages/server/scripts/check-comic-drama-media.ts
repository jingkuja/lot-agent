/** W1 local fixture. Generates its own inputs and never reads user media or calls a model. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { comicTimelineSchema } from "@lot-agent/core/comic-drama";
import { composeComicRender } from "../src/comic-drama/render-media.js";
import { ffmpeg, ffprobe, mediaCapabilities, mediaProcess } from "../src/marketing-video/media.js";
import { captionAss } from "../src/marketing-video/subtitles.js";

const width = 1080;
const height = 1920;
const fps = 30;
const first = { file: "01.mp4", frame: "01.png", video: "0x152e46", tone: 440, seconds: 6 };
const second = { file: "02.mp4", frame: "02.png", video: "0x512f30", tone: 660, seconds: 8 };
const outputOptions = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"];
const size = width + "x" + height;
const folder = await mkdtemp(join(tmpdir(), "lot-comic-drama-w1-"));
const run = (args: string[]) =>
  mediaProcess(ffmpeg(), ["-nostdin", "-v", "error", "-filter_complex_threads", "2", ...args], { cwd: folder, timeoutMs: 90_000 });

async function check(file: string, seconds: number, expectedFps = fps) {
  const data = await mediaProcess(ffprobe(), ["-v", "error", "-show_streams", "-show_format", "-of", "json", resolve(folder, file)]);
  const report = JSON.parse(data);
  const duration = Number(report.format.duration);
  const video = report.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  const audio = report.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
  assert.deepEqual([video?.codec_name, video?.width, video?.height, audio?.codec_name], ["h264", width, height, "aac"]);
  const [num, den = "1"] = String(video?.avg_frame_rate ?? "0/1").split("/");
  const actualFps = Number(num) / Number(den);
  assert.ok(Math.abs(actualFps - expectedFps) <= 0.15, `${file}: expected ${expectedFps}fps, got ${actualFps}fps`);
  assert.ok(Math.abs(duration - seconds) <= 1 / expectedFps, `${file}: expected ${seconds}s, got ${duration}s`);
  console.log(`${file} ${duration.toFixed(3)}s ${size} ${actualFps.toFixed(2)}fps H.264/AAC`);
}

async function verifyHighSpec() {
  const sourceSize = "2160x3840";
  const colors = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  const sources = [
    { path: join(folder, "high-30s.mp4"), durationMs: 30_000, color: "0x944135", takeId: randomUUID() },
    { path: join(folder, "high-8s.mp4"), durationMs: 8000, color: "0x287e99", takeId: randomUUID() },
  ];
  for (const source of sources) {
    await run(["-f", "lavfi", "-i", `color=c=${source.color}:s=${sourceSize}:r=24:d=${source.durationMs / 1000},format=yuv420p10le`,
      "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "pools=2:frame-threads=2:log-level=error",
      "-threads", "2", "-tag:v", "hvc1", ...colors, source.path]);
    const metadata = await mediaProcess(ffprobe(), ["-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", source.path]);
    const stream = JSON.parse(metadata).streams[0];
    assert.deepEqual([stream.codec_name, stream.pix_fmt, stream.width, stream.height, stream.avg_frame_rate],
      ["hevc", "yuv420p10le", 2160, 3840, "24/1"]);
  }
  const timeline = comicTimelineSchema.parse({
    schemaVersion: 1, aspectRatio: "9:16", voice: [], sfx: [], music: [],
    video: sources.map(({ takeId, durationMs }, index) => ({
      id: randomUUID(), takeId, sourceDurationMs: durationMs, inMs: 0, outMs: durationMs, volume: 1,
      transitionIn: index ? { kind: "crossfade", durationMs: 500 } : { kind: "cut", durationMs: 0 },
    })),
    subtitles: ["林夏走进便利店。", "The shop is still open.", "Toko ini masih buka."].map((line, index) => ({
      id: randomUUID(), anchor: { kind: "timeline", offsetMs: (index + 1) * 1000 }, durationMs: 1000, text: line,
    })),
  });
  const started = performance.now();
  const output = await composeComicRender(timeline, {
    videos: new Map(sources.map(source => [source.takeId, source])), audio: new Map(),
  }, AbortSignal.timeout(180_000));
  const seconds = (performance.now() - started) / 1000;
  try {
    assert.equal(output.outputFps, 24, "All-24fps 4K HEVC timeline should export natively at 24 fps");
    assert.equal(output.fpsPolicy, "native");
    assert.equal(output.pretranscoded, true, "Multi-clip 4K HEVC timeline should use segmented pre-transcoding");
    await check(output.file, 37.5, 24);
    const sample = async (file: string, at: number, key = "AVG", crop = "64:64:16:16") => {
      const stats = await run(["-ss", String(at), "-i", file, "-frames:v", "1",
        "-vf", `crop=${crop},format=yuv444p,signalstats,metadata=print:file=-`, "-f", "null", "-"]);
      const values = ["Y", "U", "V"].map(channel => Number(new RegExp(`lavfi.signalstats.${channel}${key}=([0-9.]+)`).exec(stats)?.[1]));
      assert.ok(values.every(Number.isFinite), "FFmpeg should report the sampled channels");
      return values;
    };
    const firstColor = await sample(sources[0].path, 1);
    const secondColor = await sample(sources[1].path, 1);
    const expectedBlend = firstColor.map((value, index) => (value + secondColor[index]) / 2);
    const samples = await Promise.all([sample(output.file, 2), sample(output.file, 29.75), sample(output.file, 31)]);
    const maxDelta = Math.max(...samples.flatMap((values, index) =>
      values.map((value, channel) => Math.abs(value - [firstColor, expectedBlend, secondColor][index][channel]))));
    assert.ok(maxDelta <= 6, `Unexpected BT.709 color shift on a solid patch: ${maxDelta}`);
    const [captions, clear] = await Promise.all([sample(output.file, 1.5, "MAX", "1080:960:0:960"), sample(output.file, 0.5, "MAX", "1080:960:0:960")]);
    assert.ok(captions[0] > clear[0] + 50, "Subtitle burn-in must change the picture");
    console.log(`PASS 4K HEVC Main10 (native 24fps, pretranscoded): 30s + 8s, subtitles and crossfade, 1080p export in ${seconds.toFixed(2)}s, max YUV delta ${maxDelta.toFixed(2)}`);
  } finally { await output.dispose(); }
  // Verify mixed-fps (24fps + 30fps) timeline converts explicitly to CFR 30fps.
  const clip30Path = join(folder, "mixed-30fps-2s.mp4");
  const clip30TakeId = randomUUID();
  await run(["-f", "lavfi", "-i", "color=c=0x287e99:s=1080x1920:r=30:d=2", ...outputOptions, clip30Path]);
  const mixedTimeline = comicTimelineSchema.parse({
    schemaVersion: 1, aspectRatio: "9:16", voice: [], sfx: [], music: [], subtitles: [],
    video: [
      { id: randomUUID(), takeId: sources[1].takeId, sourceDurationMs: 8000, inMs: 0, outMs: 2000, volume: 1,
        transitionIn: { kind: "cut", durationMs: 0 } },
      { id: randomUUID(), takeId: clip30TakeId, sourceDurationMs: 2000, inMs: 0, outMs: 2000, volume: 1,
        transitionIn: { kind: "cut", durationMs: 0 } },
    ],
  });
  const mixed = await composeComicRender(mixedTimeline, {
    videos: new Map([[sources[1].takeId, sources[1]], [clip30TakeId, { path: clip30Path, durationMs: 2000 }]]),
    audio: new Map(),
  }, AbortSignal.timeout(120_000), { fpsMode: "auto" });
  try {
    assert.equal(mixed.outputFps, 30);
    assert.equal(mixed.fpsPolicy, "cfr_convert");
    assert.equal(mixed.mixedSourceFps, true);
    await check(mixed.file, 4, 30);
    console.log("PASS mixed-fps (24fps + 30fps → CFR 30fps): 4.000s");
  } finally { await mixed.dispose(); }
}

try {
  assert.deepEqual(await mediaCapabilities(), { composition: true, subtitles: true }, "FFmpeg composition with libass is required");
  if (process.argv.includes("--high-spec")) await verifyHighSpec();
  for (const clip of [first, second]) {
    const video = `color=c=${clip.video}:s=${size}:r=${fps}:d=${clip.seconds},drawgrid=w=180:h=240:t=2:c=white@0.2`;
    const audio = `sine=frequency=${clip.tone}:sample_rate=48000:duration=${clip.seconds}`;
    await run(["-f", "lavfi", "-i", video, "-f", "lavfi", "-i", audio, ...outputOptions, clip.file]);
    await check(clip.file, clip.seconds);
    await run(["-i", clip.file, "-frames:v", "1", "-update", "1", clip.frame]);
  }
  await writeFile(join(folder, "preview.ass"), captionAss([
    { start: 1, end: 4, text: "林夏走进便利店。" },
    { start: 4, end: 7, text: "The shop is still open." },
    { start: 7, end: 11, text: "Toko ini masih buka." },
  ], width, height));
  const trim = [
    "[0:v]settb=AVTB,setpts=PTS-STARTPTS[v0]",
    "[1:v]trim=start=0.4:end=7.6,settb=AVTB,setpts=PTS-STARTPTS[v1]",
    "[0:a]atrim=end=6,asetpts=PTS-STARTPTS[a0]",
    "[1:a]atrim=start=0.4:end=7.6,asetpts=PTS-STARTPTS[a1]",
  ];
  for (const variant of [
    { file: "preview-13.2s.mp4", seconds: 13.2, join: "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" },
    { file: "preview-12.7s.mp4", seconds: 12.7, join: "[v0][v1]xfade=duration=0.5:offset=5.5[v];[a0][a1]acrossfade=d=0.5[a]" },
  ]) {
    const filters = [...trim, variant.join, "[v]subtitles=preview.ass:charenc=UTF-8[out]"].join(";");
    await run(["-i", first.file, "-i", second.file, "-filter_complex", filters, "-map", "[out]", "-map", "[a]", ...outputOptions, variant.file]);
    await check(variant.file, variant.seconds);
  }
  await run(["-ss", "2", "-i", "preview-13.2s.mp4", "-vf", "scale=270:-2", "-frames:v", "1", "-update", "1", "caption-zh.png"]);
  console.log(folder);
} catch (error) {
  await rm(folder, { recursive: true, force: true });
  throw error;
}
