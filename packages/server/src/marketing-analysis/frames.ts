import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { ANALYSIS_LIMITS, FrameEvidenceSchema, selectAnalysisFrames, type AnalysisSource, type FrameEvidence } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";
import { analysisParallelism } from "./config.js";
import type { MediaRunner } from "./sandbox.js";
import { readAnalysisFile } from "./private-files.js";

function timeMs(pts: string, start: string, timeBase: string): number {
  const [n, d] = timeBase.split("/").map(BigInt);
  return Number(((BigInt(pts) - BigInt(start)) * 1000n * n + d / 2n) / d);
}

export function parseFrameLog(log: string, sourceHash: string, startPts: string): FrameEvidence[] {
  const timeBase = log.match(/config in time_base:\s*(\d+\/\d+)/)?.[1];
  if (!timeBase || !/^[1-9]\d*\/[1-9]\d*$/.test(timeBase)) throw new AnalysisError("INVALID_FRAME_TIMESTAMPS");
  const frames: FrameEvidence[] = [];
  for (const match of log.matchAll(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:[^\n]*?\bs:(\d+)x(\d+)/g)) {
    if (Number(match[1]) !== frames.length) throw new AnalysisError("INVALID_FRAME_TIMESTAMPS");
    frames.push(FrameEvidenceSchema.parse({ id: `f${String(frames.length + 1).padStart(4, "0")}`, sourceHash, sourcePts: match[2], timeBase,
      ptsMs: timeMs(match[2], startPts, timeBase), width: Number(match[3]), height: Number(match[4]), objectKey: `frame-${String(frames.length + 1).padStart(4, "0")}.jpg`, reasons: [] }));
  }
  if (!frames.length || frames.length > ANALYSIS_LIMITS.candidates) throw new AnalysisError("INVALID_FRAME_TIMESTAMPS");
  return frames;
}

/** Only local, signature-checked containers enter the network-less decoder.
 * A select filter preserves source PTS; no fps filter invents timestamps. */
export async function extractAnalysisFrames(input: { directory: string; source: AnalysisSource; runner: MediaRunner; threads?: number; signal?: AbortSignal }) {
  const threads = String(analysisParallelism({ decodeThreads: input.threads }).decodeThreads);
  const key = input.source.mediaKey;
  if (!key || !/^source\.(mp4|webm|mkv)$/.test(key) || !/^[a-f0-9]{64}$/.test(input.source.sourceHash ?? "")) throw new AnalysisError("INVALID_PRIVATE_FILE");
  const path = join(input.directory, key); const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > ANALYSIS_LIMITS.downloadBytes) throw new AnalysisError("INVALID_PRIVATE_FILE");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const head = Buffer.alloc(32);
  try { await handle.read(head); } finally { await handle.close(); }
  const format = head.toString("ascii", 4, 8) === "ftyp" ? "mov" : head.readUInt32BE(0) === 0x1a45dfa3 ? "matroska" : null;
  if (!format) throw new AnalysisError("UNSUPPORTED_SOURCE");
  const local = `/work/${key}`;
  const probe = JSON.parse((await input.runner.run("ffprobe", ["-v", "error", "-threads", threads, "-protocol_whitelist", "file", "-f", format, "-select_streams", "v:0", "-show_streams", "-show_format", "-show_frames",
    "-show_entries", "format=duration,start_time,format_name:stream=width,height,time_base,duration:stream_side_data=rotation:frame=best_effort_timestamp,duration,pkt_duration", "-of", "json", local], input.signal)).stdout);
  const stream = probe.streams?.[0];
  if (!stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width <= 0 || stream.height <= 0 || stream.width > 1920 || stream.height > 1920 || stream.width * stream.height > 1920 * 1080) throw new AnalysisError("PIXEL_LIMIT");
  if (!Array.isArray(probe.frames) || !probe.frames.length || probe.frames.length > 21601 || !/^[1-9]\d*\/[1-9]\d*$/.test(stream.time_base)) throw new AnalysisError("INVALID_FRAME_TIMESTAMPS");
  if (probe.frames.some((frame: any) => typeof frame.best_effort_timestamp === "number" && !Number.isSafeInteger(frame.best_effort_timestamp))) throw new AnalysisError("INVALID_FRAME_TIMESTAMPS");
  const pts = probe.frames.map((frame: any) => String(frame.best_effort_timestamp));
  if (pts.some((value: string, i: number) => !/^-?\d+$/.test(value) || (i && BigInt(value) <= BigInt(pts[i - 1])))) throw new AnalysisError("INVALID_FRAME_TIMESTAMPS");
  const start = pts[0]; const last = pts.at(-1)!;
  // Containers without stream duration can report an absolute end time:
  // e.g. a 2s WebM starting at PTS 190s has format.duration=192s. Normalize
  // that offset, but also measure decoded frames to catch under-reporting.
  const streamDuration = Number(stream.duration);
  const metadataDuration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration
    : Number(probe.format?.duration) - Math.max(0, Number(probe.format?.start_time ?? 0));
  const lastDuration = String(probe.frames.at(-1)?.duration ?? probe.frames.at(-1)?.pkt_duration ?? "0");
  if (!/^\d+$/.test(lastDuration)) throw new AnalysisError("INVALID_FRAME_TIMESTAMPS");
  const durationMs = Math.max(Number.isFinite(metadataDuration) ? Math.ceil(metadataDuration * 1000) : 0,
    timeMs(String(BigInt(last) + BigInt(lastDuration)), start, stream.time_base));
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new AnalysisError("UNSUPPORTED_SOURCE");
  if (durationMs > ANALYSIS_LIMITS.durationMs) throw new AnalysisError("DURATION_LIMIT");
  // showinfo after scaling retains timestamps while reporting delivered dimensions.
  const filter = `[0:v:0]select='isnan(prev_selected_t)+gte(t-prev_selected_t,0.5)+eq(n,${pts.length - 1})',scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,showinfo,split[image][small];[small]scale=96:54,format=gray[gray]`;
  const output = await input.runner.run("ffmpeg", ["-nostdin", "-hide_banner", "-y", "-loglevel", "info", "-copyts", "-threads", threads, "-filter_complex_threads", threads, "-protocol_whitelist", "file", "-f", format, "-i", local,
    "-filter_complex", filter, "-map", "[image]", "-fps_mode", "passthrough", "-frames:v", "361", "-threads", threads, "-q:v", "2", "/work/frame-%04d.jpg",
    "-map", "[gray]", "-fps_mode", "passthrough", "-frames:v", "361", "-threads", threads, "-f", "rawvideo", "/work/gray.raw"], input.signal);
  const frames = parseFrameLog(output.stderr, input.source.sourceHash!, start);
  if (frames[0].timeBase !== stream.time_base || frames.at(-1)?.sourcePts !== last || frames[0].sourcePts !== start) throw new AnalysisError("INVALID_FRAME_TIMESTAMPS");
  const raw = await readAnalysisFile(input.directory, "gray.raw", ANALYSIS_LIMITS.candidates * 96 * 54);
  if (raw.length !== frames.length * 96 * 54) throw new AnalysisError("INVALID_GRAY_FRAME");
  const selection = selectAnalysisFrames(frames, frames.map((_, i) => raw.subarray(i * 96 * 54, (i + 1) * 96 * 54)));
  return { ...selection, durationMs };
}
