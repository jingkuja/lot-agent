import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMIC_RENDER_FPS, COMIC_RENDER_MAX_INPUTS, comicFrame, comicRenderDurationToleranceMs, comicRenderIssue, layoutComicTimeline,
  resolveComicRenderFps, type ComicRenderFps, type ComicRenderFpsMode, type ComicRenderFramePolicy, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { ffmpeg, inspectMedia, mediaCapabilities, mediaProcess } from "../marketing-video/media.js";
import { captionAss } from "../marketing-video/subtitles.js";
import {
  checkDiskFreeSpace, comicRenderMinFreeBytes, registerActiveComicTempDir, unregisterActiveComicTempDir, type StatfsFn,
} from "./temp-cleanup.js";

export type ComicRenderSource = { path: string; durationMs: number };
export const COMIC_RENDER_PREMIX_BATCH = 32;
export const COMIC_RENDER_PRETRANSCODE_CLIP_THRESHOLD = 8;
export const COMIC_RENDER_HIGH_SPEC_PRETRANSCODE_CLIPS = 2;
export const COMIC_RENDER_VIDEO_JOIN_BATCH = 8;
const rate = 48_000;
const sec = (ms: number) => (ms / 1000).toFixed(6);
const stereo = `aresample=${rate},aformat=sample_fmts=fltp:channel_layouts=stereo`;
const delay = (ms: number) => `adelay=${ms * (rate / 1000)}S:all=1`;

export class ComicRenderFailure extends Error {
  constructor(readonly errorCode: string) { super(errorCode); }
}

type Media = Awaited<ReturnType<typeof inspectMedia>>;
type TrackSource = ComicRenderSource & { info: Media };
type AudioTrackName = "voice" | "music" | "sfx";
type AudioClip = ComicTimeline[AudioTrackName][number];
export type PremixClipEntry = {
  path: string;
  format: string;
  sourceDurationMs: number;
  startMs: number;
  clip: AudioClip;
};
export type PremixPass = {
  output: string;
  inputCount: number;
  args: string[];
};
export type ComicRenderComposeOptions = {
  forcePremix?: boolean;
  forcePretranscode?: boolean;
  preview?: boolean;
  fpsMode?: ComicRenderFpsMode;
  onHeartbeat?: () => void;
  mediaRoot?: string;
  minFreeBytes?: number;
  statfs?: StatfsFn;
};
export type ComicRenderOutput = {
  file: string;
  dispose: () => Promise<void>;
  outputFps: ComicRenderFps;
  fpsPolicy: ComicRenderFramePolicy;
  mixedSourceFps: boolean;
  pretranscoded: boolean;
};

export function shouldPremixComicAudio(timeline: ComicTimeline): boolean {
  return timeline.video.length + timeline.voice.length + timeline.sfx.length + timeline.music.length > COMIC_RENDER_MAX_INPUTS;
}

export function isHighSpecVideoSource(
  info: { width: number; height: number; videoCodec?: string; pixFmt?: string },
): boolean {
  const maxDim = Math.max(info.width, info.height);
  const pixels = info.width * info.height;
  return maxDim >= 2160 || pixels > 2_500_000 || info.videoCodec === "hevc" || (info.pixFmt ?? "").includes("10");
}

export function shouldPretranscodeComicVideo(
  timeline: ComicTimeline,
  videoSources: ReadonlyMap<string, { info: { width: number; height: number; videoCodec?: string; pixFmt?: string } }>,
): boolean {
  if (timeline.video.length >= COMIC_RENDER_PRETRANSCODE_CLIP_THRESHOLD) return true;
  let highSpecClips = 0;
  for (const clip of timeline.video) {
    const source = videoSources.get(clip.takeId);
    if (source && isHighSpecVideoSource(source.info)) highSpecClips += 1;
  }
  return highSpecClips >= COMIC_RENDER_HIGH_SPEC_PRETRANSCODE_CLIPS;
}

export function estimateComicRenderTempBytes(
  durationMs: number,
  pretranscoded: boolean,
  minFloorBytes = comicRenderMinFreeBytes(),
): number {
  const seconds = Math.max(1, Math.ceil(durationMs / 1000));
  const perSecond = pretranscoded ? 6 * 1024 * 1024 : 2 * 1024 * 1024;
  return Math.max(minFloorBytes, seconds * perSecond + 64 * 1024 * 1024);
}

export function buildAudioItemFilter(clip: AudioClip, sourceDurationMs: number, startMs: number): string {
  const filters = [stereo, `atrim=start=${sec(clip.sourceInMs)}`, "asetpts=N/SR/TB"];
  if (clip.loop) filters.push(`aloop=loop=-1:size=${(sourceDurationMs - clip.sourceInMs) * rate / 1000}`);
  filters.push(`atrim=duration=${sec(clip.durationMs)}`, `volume=${clip.volume}`);
  if (clip.fadeInMs) filters.push(`afade=t=in:d=${sec(clip.fadeInMs)}`);
  if (clip.fadeOutMs) filters.push(`afade=t=out:st=${sec(clip.durationMs - clip.fadeOutMs)}:d=${sec(clip.fadeOutMs)}`);
  filters.push(delay(startMs));
  return filters.join(",");
}

function buildStemMixPass(
  inputs: { path: string; format: string; filter: string }[],
  duration: string,
  output: string,
): PremixPass {
  const args = ["-nostdin", "-y", "-v", "error", "-filter_complex_threads", "2"];
  const graph: string[] = [];
  const mix = ["[silence]"];
  inputs.forEach((entry, index) => {
    args.push("-threads", "1", "-protocol_whitelist", "file,pipe", "-f", entry.format);
    if (entry.format === "mov") args.push("-enable_drefs", "0");
    args.push("-i", entry.path);
    graph.push(`[${index}:a:0]${entry.filter}[a${index}]`);
    mix.push(`[a${index}]`);
  });
  graph.push(`anullsrc=r=${rate}:cl=stereo:d=${duration}[silence]`);
  graph.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0[stem]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[stem]", "-t", duration,
    "-f", "wav", "-c:a", "pcm_f32le", "-ar", String(rate), "-ac", "2", output);
  return { output, inputCount: inputs.length, args };
}

function planCustomStemPremix(
  prefix: string,
  inputs: { path: string; format: string; filter: string }[],
  duration: string,
  batchSize = COMIC_RENDER_PREMIX_BATCH,
): { passes: PremixPass[]; finalStem: string } {
  const finalStem = `stem-${prefix}.wav`;
  if (inputs.length <= batchSize) {
    return { passes: [buildStemMixPass(inputs, duration, finalStem)], finalStem };
  }
  const passes: PremixPass[] = [];
  let stageFiles: string[] = [];
  for (let offset = 0, part = 0; offset < inputs.length; offset += batchSize, part++) {
    const chunk = inputs.slice(offset, offset + batchSize);
    const out = `stem-${prefix}-p0-${part}.wav`;
    passes.push(buildStemMixPass(chunk, duration, out));
    stageFiles.push(out);
  }
  let level = 1;
  while (stageFiles.length > batchSize) {
    const next: string[] = [];
    for (let offset = 0, part = 0; offset < stageFiles.length; offset += batchSize, part++) {
      const chunk = stageFiles.slice(offset, offset + batchSize);
      const out = `stem-${prefix}-p${level}-${part}.wav`;
      passes.push(buildStemMixPass(chunk.map(path => ({ path, format: "wav", filter: stereo })), duration, out));
      next.push(out);
    }
    stageFiles = next;
    level++;
  }
  passes.push(buildStemMixPass(stageFiles.map(path => ({ path, format: "wav", filter: stereo })), duration, finalStem));
  return { passes, finalStem };
}

/**
 * Plans bounded-input FFmpeg premix passes for a single audio track so even 240 audio items
 * never exceed `COMIC_RENDER_PREMIX_BATCH` inputs per FFmpeg process.
 */
export function planAudioStemPremix(
  track: AudioTrackName,
  entries: PremixClipEntry[],
  duration: string,
  batchSize = COMIC_RENDER_PREMIX_BATCH,
): { passes: PremixPass[]; finalStem: string } {
  return planCustomStemPremix(
    track,
    entries.map(entry => ({
      path: entry.path,
      format: entry.format,
      filter: buildAudioItemFilter(entry.clip, entry.sourceDurationMs, entry.startMs),
    })),
    duration,
    batchSize,
  );
}

async function probe(source: ComicRenderSource, video: boolean, signal: AbortSignal): Promise<TrackSource> {
  const info = await inspectMedia(source.path, signal).catch(() => null);
  signal.throwIfAborted();
  if (!info || (video ? !info.video || info.format !== "mov" : !info.audio || info.video || !["mp3", "wav"].includes(info.format))) {
    throw new ComicRenderFailure("RENDER_SOURCE_UNAVAILABLE");
  }
  if (Math.abs(info.duration * 1000 - source.durationMs) > 1) throw new ComicRenderFailure("RENDER_SOURCE_CHANGED");
  return { ...source, info };
}

function buildOriginalClipAudioFilter(
  timeline: ComicTimeline,
  index: number,
  startMs: number,
): string {
  const clip = timeline.video[index];
  const length = clip.outMs - clip.inMs;
  const fadeIn = clip.transitionIn.durationMs;
  const fadeOut = timeline.video[index + 1]?.transitionIn.durationMs ?? 0;
  const fades = [
    fadeIn && `afade=t=in:d=${sec(fadeIn)}`,
    fadeOut && `afade=t=out:st=${sec(length - fadeOut)}:d=${sec(fadeOut)}`,
  ].filter(Boolean);
  return [stereo, `atrim=start=${sec(clip.inMs)}:end=${sec(clip.outMs)}`, "asetpts=N/SR/TB", `volume=${clip.volume}`, ...fades, delay(startMs)].join(",");
}

async function pretranscodeAndJoinVideos(params: {
  timeline: ComicTimeline;
  layout: ReturnType<typeof layoutComicTimeline>;
  videoSources: ReadonlyMap<string, TrackSource>;
  width: number;
  height: number;
  targetFps: ComicRenderFps;
  folder: string;
  signal: AbortSignal;
  onHeartbeat?: () => void;
}): Promise<{ joinedVideoFile: string; originalAudioInputs: { path: string; format: string; filter: string }[] }> {
  const { timeline, layout, videoSources, width, height, targetFps, folder, signal, onHeartbeat } = params;
  const frameSec = (frame: number) => (frame / targetFps).toFixed(6);
  const timebase = `settb=1/${targetFps},setpts=N`;
  const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const pad = `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  const proxyFiles: string[] = [];
  const originalAudioInputs: { path: string; format: string; filter: string }[] = [];

  // Step 1: Sequentially pre-transcode each clip to a normalized 1080p CFR proxy so peak 4K/HEVC decoders stay at 1.
  for (const [index, clip] of timeline.video.entries()) {
    signal.throwIfAborted();
    const source = videoSources.get(clip.takeId);
    if (!source || source.durationMs !== clip.sourceDurationMs) throw new ComicRenderFailure("RENDER_SOURCE_CHANGED");
    const item = layout.video[index];
    const frames = comicFrame(item.endMs, targetFps) - comicFrame(item.startMs, targetFps);
    const from = Math.floor(clip.inMs * targetFps / 1000);
    const normalize = `setpts=PTS-STARTPTS,fps=${targetFps},${scale},${pad},setsar=1,format=yuv444p,tpad=stop_mode=clone:stop_duration=${sec(source.durationMs)}`;
    const filter = `[0:v:0]${normalize},trim=start_frame=${from}:end_frame=${from + frames},${timebase},format=yuv420p[v]`;
    const proxyName = `clip-proxy-${index}.mp4`;
    await mediaProcess(ffmpeg(), [
      "-nostdin", "-y", "-v", "error", "-filter_complex_threads", "2",
      "-threads", "1", "-protocol_whitelist", "file,pipe", "-f", source.info.format, "-enable_drefs", "0", "-i", source.path,
      "-filter_complex", filter, "-map", "[v]", "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p",
      "-r", String(targetFps), "-video_track_timescale", String(targetFps * 1000), "-threads", "2", proxyName,
    ], { cwd: folder, signal, timeoutMs: 300_000 });
    proxyFiles.push(proxyName);
    if (source.info.audio && clip.volume > 0) {
      originalAudioInputs.push({
        path: source.path,
        format: source.info.format,
        filter: buildOriginalClipAudioFilter(timeline, index, item.startMs),
      });
    }
    onHeartbeat?.();
  }

  // Step 2: Join normalized proxies using stream-copy concat (cut-only) or bounded-batch xfade reduction.
  if (proxyFiles.length === 1) {
    return { joinedVideoFile: proxyFiles[0], originalAudioInputs };
  }
  const cutOnly = timeline.video.every(clip => clip.transitionIn.kind === "cut");
  if (cutOnly) {
    await writeFile(join(folder, "proxies.txt"), proxyFiles.map(name => `file '${name}'`).join("\n"));
    await mediaProcess(ffmpeg(), [
      "-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe",
      "-f", "concat", "-safe", "1", "-i", "proxies.txt", "-c:v", "copy", "-an", "joined-video.mp4",
    ], { cwd: folder, signal, timeoutMs: 300_000 });
    await Promise.allSettled(proxyFiles.map(name => rm(join(folder, name), { force: true })));
    onHeartbeat?.();
    return { joinedVideoFile: "joined-video.mp4", originalAudioInputs };
  }

  let currentJoined: string | null = null;
  let cursor = 0;
  let stage = 0;
  while (cursor < timeline.video.length) {
    signal.throwIfAborted();
    const maxNew = currentJoined ? COMIC_RENDER_VIDEO_JOIN_BATCH - 1 : COMIC_RENDER_VIDEO_JOIN_BATCH;
    const end = Math.min(timeline.video.length, cursor + maxNew);
    const args = ["-nostdin", "-y", "-v", "error", "-filter_complex_threads", "2"];
    const graph: string[] = [];
    const consumed: string[] = [];
    let inputIndex = 0;
    const addProxyInput = (name: string) => {
      args.push("-threads", "1", "-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0", "-i", name);
      const idx = inputIndex++;
      graph.push(`[${idx}:v:0]setpts=PTS-STARTPTS,fps=${targetFps},format=yuv444p,${timebase}[s${idx}]`);
      return `[s${idx}]`;
    };
    let picture = currentJoined ? addProxyInput(currentJoined) : addProxyInput(proxyFiles[cursor]);
    if (currentJoined) consumed.push(currentJoined);
    else consumed.push(proxyFiles[cursor]);
    const loopStart = currentJoined ? cursor : cursor + 1;
    for (let clipIndex = loopStart; clipIndex < end; clipIndex += 1) {
      const nextStream = addProxyInput(proxyFiles[clipIndex]);
      consumed.push(proxyFiles[clipIndex]);
      const clip = timeline.video[clipIndex];
      const item = layout.video[clipIndex];
      const { kind } = clip.transitionIn;
      const overlap = comicFrame(layout.video[clipIndex - 1].endMs, targetFps) - comicFrame(item.startMs, targetFps);
      const blend = kind === "cut"
        ? "concat=n=2:v=1:a=0"
        : `xfade=transition=${kind === "black" ? "fadeblack" : "fade"}:duration=${frameSec(overlap)}:offset=${frameSec(comicFrame(item.startMs, targetFps))}`;
      graph.push(`${picture}${nextStream}${blend},${timebase}[j${clipIndex}]`);
      picture = `[j${clipIndex}]`;
    }
    graph.push(`${picture}format=yuv420p[vout]`);
    const stageOut = end >= timeline.video.length ? "joined-video.mp4" : `join-stage-${stage}.mp4`;
    await mediaProcess(ffmpeg(), [
      ...args, "-filter_complex", graph.join(";"), "-map", "[vout]", "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p",
      "-r", String(targetFps), "-video_track_timescale", String(targetFps * 1000), "-threads", "2", stageOut,
    ], { cwd: folder, signal, timeoutMs: 600_000 });
    await Promise.allSettled(consumed.map(name => rm(join(folder, name), { force: true })));
    currentJoined = stageOut;
    cursor = end;
    stage += 1;
    onHeartbeat?.();
  }
  return { joinedVideoFile: currentJoined ?? "joined-video.mp4", originalAudioInputs };
}

export async function composeComicRender(timeline: ComicTimeline, inputs: {
  videos: ReadonlyMap<string, ComicRenderSource>; audio: ReadonlyMap<string, ComicRenderSource>;
}, signal: AbortSignal, options: ComicRenderComposeOptions = {}): Promise<ComicRenderOutput> {
  const initialFps: ComicRenderFps = options.fpsMode === "24" ? 24 : COMIC_RENDER_FPS;
  const issue = comicRenderIssue(timeline, initialFps);
  if (issue) throw new ComicRenderFailure(issue);
  const support = await mediaCapabilities();
  if (!support.composition || (timeline.subtitles.length && !support.subtitles)) throw new ComicRenderFailure("RENDER_FFMPEG_UNAVAILABLE");
  if (timeline.video.some(item => item.transitionIn.kind !== "cut")) {
    const filters = await mediaProcess(ffmpeg(), ["-hide_banner", "-filters"], { signal, timeoutMs: 5000 }).catch(() => "");
    if (!/^\s*[.TSC]+\s+xfade\s/m.test(filters)) throw new ComicRenderFailure("RENDER_FFMPEG_UNAVAILABLE");
  }
  const videoSources = new Map<string, TrackSource>();
  const audioSources = new Map<string, TrackSource>();
  // Probe sequentially so one active export does not consume the process pool.
  for (const [key, source] of inputs.videos) {
    videoSources.set(key, await probe(source, true, signal));
    options.onHeartbeat?.();
  }
  for (const [key, source] of inputs.audio) {
    audioSources.set(key, await probe(source, false, signal));
  }
  for (const clip of timeline.video) {
    const source = videoSources.get(clip.takeId);
    if (!source || source.durationMs !== clip.sourceDurationMs) throw new ComicRenderFailure("RENDER_SOURCE_CHANGED");
  }
  const sourceFpsValues = timeline.video.map(clip => videoSources.get(clip.takeId)?.info.fps ?? 0);
  const fpsPlan = resolveComicRenderFps(sourceFpsValues, options.fpsMode ?? "auto");
  const targetFps = fpsPlan.fps;
  const targetIssue = comicRenderIssue(timeline, targetFps);
  if (targetIssue) throw new ComicRenderFailure(targetIssue);

  const bounds = options.preview
    ? ({ "9:16": [540, 960], "16:9": [960, 540], "1:1": [720, 720] } as const)
    : ({ "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080] } as const);
  const [width, height] = bounds[timeline.aspectRatio];
  const layout = layoutComicTimeline(timeline);
  const frameSec = (frame: number) => (frame / targetFps).toFixed(6);
  const timebase = `settb=1/${targetFps},setpts=N`;
  const duration = frameSec(comicFrame(layout.durationMs, targetFps));
  const audioTrackEntries = new Map<AudioTrackName, PremixClipEntry[]>();
  for (const track of ["voice", "music", "sfx"] as const) {
    const entries: PremixClipEntry[] = [];
    for (const [index, clip] of timeline[track].entries()) {
      const source = audioSources.get(clip.mediaId);
      if (!source || clip.sourceInMs >= source.durationMs || (!clip.loop && clip.sourceInMs + clip.durationMs > source.durationMs)) {
        throw new ComicRenderFailure("RENDER_SOURCE_CHANGED");
      }
      entries.push({ path: source.path, format: source.info.format, sourceDurationMs: source.durationMs, startMs: layout[track][index].startMs, clip });
    }
    if (entries.length) audioTrackEntries.set(track, entries);
  }

  const usePretranscode = options.forcePretranscode || shouldPretranscodeComicVideo(timeline, videoSources);
  const premix = options.forcePremix || usePretranscode || shouldPremixComicAudio(timeline);
  const minFloor = options.minFreeBytes ?? comicRenderMinFreeBytes();
  const requiredTempBytes = estimateComicRenderTempBytes(layout.durationMs, usePretranscode, minFloor);
  const tempDisk = await checkDiskFreeSpace(tmpdir(), requiredTempBytes, options.statfs);
  if (!tempDisk.ok) throw new ComicRenderFailure("RENDER_DISK_SPACE_LOW");
  if (options.mediaRoot) {
    const mediaDisk = await checkDiskFreeSpace(options.mediaRoot, Math.max(minFloor, 64 * 1024 * 1024), options.statfs);
    if (!mediaDisk.ok) throw new ComicRenderFailure("RENDER_DISK_SPACE_LOW");
  }

  const folder = await mkdtemp(join(tmpdir(), "lot-comic-render-"));
  registerActiveComicTempDir(folder);
  const dispose = async () => {
    try { await rm(folder, { recursive: true, force: true }); }
    finally { unregisterActiveComicTempDir(folder); }
  };

  try {
    const args = ["-nostdin", "-y", "-v", "error", "-filter_complex_threads", "2"];
    const graph: string[] = [];
    const mix: string[] = ["[silence]"];
    let nextInput = 0;
    const addInput = (path: string, format: string) => {
      args.push("-threads", "1", "-protocol_whitelist", "file,pipe", "-f", format);
      if (format === "mov") args.push("-enable_drefs", "0");
      args.push("-i", path);
      return nextInput++;
    };
    let picture = "[clip0]";

    if (usePretranscode) {
      const { joinedVideoFile, originalAudioInputs } = await pretranscodeAndJoinVideos({
        timeline, layout, videoSources, width, height, targetFps, folder, signal, onHeartbeat: options.onHeartbeat,
      });
      const videoIdx = addInput(join(folder, joinedVideoFile), "mov");
      graph.push(`[${videoIdx}:v:0]setpts=PTS-STARTPTS,fps=${targetFps},format=yuv444p,${timebase}[clip0]`);
      if (originalAudioInputs.length) {
        const plan = planCustomStemPremix("original", originalAudioInputs, duration);
        for (const pass of plan.passes) {
          signal.throwIfAborted();
          await mediaProcess(ffmpeg(), pass.args, { cwd: folder, signal, timeoutMs: 300_000 });
          options.onHeartbeat?.();
        }
        graph.push(`[${addInput(join(folder, plan.finalStem), "wav")}:a:0]${stereo}[stem_original]`);
        mix.push("[stem_original]");
      }
    } else {
      const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
      const pad = `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
      for (const [index, clip] of timeline.video.entries()) {
        signal.throwIfAborted();
        const source = videoSources.get(clip.takeId)!;
        const input = addInput(source.path, source.info.format);
        const item = layout.video[index];
        const frames = comicFrame(item.endMs, targetFps) - comicFrame(item.startMs, targetFps);
        const from = Math.floor(clip.inMs * targetFps / 1000);
        const normalize = `setpts=PTS-STARTPTS,fps=${targetFps},${scale},${pad},setsar=1,format=yuv444p,tpad=stop_mode=clone:stop_duration=${sec(source.durationMs)}`;
        graph.push(`[${input}:v:0]${normalize},trim=start_frame=${from}:end_frame=${from + frames},${timebase}[clip${index}]`);
        if (index) {
          const { kind } = clip.transitionIn;
          const overlap = comicFrame(layout.video[index - 1].endMs, targetFps) - comicFrame(item.startMs, targetFps);
          const blend = kind === "cut"
            ? "concat=n=2:v=1:a=0"
            : `xfade=transition=${kind === "black" ? "fadeblack" : "fade"}:duration=${frameSec(overlap)}:offset=${frameSec(comicFrame(item.startMs, targetFps))}`;
          graph.push(`${picture}[clip${index}]${blend},${timebase}[join${index}]`);
          picture = `[join${index}]`;
        }
        if (!source.info.audio || clip.volume === 0) continue;
        graph.push(`[${input}:a:0]${buildOriginalClipAudioFilter(timeline, index, item.startMs)}[original${index}]`);
        mix.push(`[original${index}]`);
      }
    }

    if (premix) {
      for (const [track, entries] of audioTrackEntries) {
        signal.throwIfAborted();
        const plan = planAudioStemPremix(track, entries, duration);
        for (const pass of plan.passes) {
          signal.throwIfAborted();
          await mediaProcess(ffmpeg(), pass.args, { cwd: folder, signal, timeoutMs: 300_000 });
          options.onHeartbeat?.();
        }
        const label = `[stem_${track}]`;
        graph.push(`[${addInput(join(folder, plan.finalStem), "wav")}:a:0]${stereo}${label}`);
        mix.push(label);
      }
    } else {
      for (const [track, entries] of audioTrackEntries) {
        for (const [index, entry] of entries.entries()) {
          const label = `[${track}${index}]`;
          const filter = buildAudioItemFilter(entry.clip, entry.sourceDurationMs, entry.startMs);
          graph.push(`[${addInput(entry.path, entry.format)}:a:0]${filter}${label}`);
          mix.push(label);
        }
      }
    }
    graph.push(`anullsrc=r=${rate}:cl=stereo:d=${duration}[silence]`);
    graph.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0,alimiter=limit=0.97:level=0:latency=1[audio]`);
    let captions = "";
    if (timeline.subtitles.length) {
      const cues = timeline.subtitles.map((caption, index) => ({
        text: caption.text, start: layout.subtitles[index].startMs / 1000, end: layout.subtitles[index].endMs / 1000,
      }));
      await writeFile(join(folder, "captions.ass"), captionAss(cues, width, height, timeline.captionStyle));
      captions = "subtitles=filename=captions.ass,";
    }
    graph.push(`${picture}${captions}format=yuv420p[video]`);
    const file = join(folder, "film.mp4");
    await mediaProcess(ffmpeg(), [
      ...args, "-filter_complex", graph.join(";"), "-map", "[video]", "-map", "[audio]", "-t", duration,
      "-r", String(targetFps), "-c:v", "libx264", "-preset", options.preview ? "ultrafast" : "veryfast", "-threads", "2",
      "-crf", options.preview ? "25" : "20", "-maxrate", options.preview ? "4M" : "8M", "-bufsize", options.preview ? "8M" : "16M",
      "-c:a", "aac", "-b:a", "160k", "-ar", String(rate), "-movflags", "+faststart", "film.mp4",
    ], { cwd: folder, signal, timeoutMs: 900_000 });
    const info = await inspectMedia(file, signal);
    const toleranceMs = comicRenderDurationToleranceMs(targetFps);
    if (!info.video || !info.audio || info.width !== width || info.height !== height
      || Math.abs(info.duration * 1000 - layout.durationMs) > toleranceMs) {
      throw new ComicRenderFailure("RENDER_OUTPUT_INVALID");
    }
    return {
      file,
      dispose,
      outputFps: targetFps,
      fpsPolicy: fpsPlan.policy,
      mixedSourceFps: fpsPlan.mixedSourceFps,
      pretranscoded: usePretranscode,
    };
  } catch (error) { await dispose(); throw error; }
}
