/** W1 local fixture. Generates its own inputs and never reads user media or calls a model. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function check(file: string, seconds: number) {
  const data = await mediaProcess(ffprobe(), ["-v", "error", "-show_streams", "-show_format", "-of", "json", join(folder, file)]);
  const report = JSON.parse(data);
  const duration = Number(report.format.duration);
  const video = report.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  const audio = report.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
  assert.deepEqual([video?.codec_name, video?.width, video?.height, audio?.codec_name], ["h264", width, height, "aac"]);
  assert.ok(Math.abs(duration - seconds) <= 1 / fps, `${file}: expected ${seconds}s, got ${duration}s`);
  console.log(`${file} ${duration.toFixed(3)}s ${size} H.264/AAC`);
}

try {
  assert.deepEqual(await mediaCapabilities(), { composition: true, subtitles: true }, "FFmpeg composition with libass is required");
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
