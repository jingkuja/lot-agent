import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMIC_RENDER_FPS, COMIC_RENDER_MAX_INPUTS, comicFrame, comicRenderIssue, layoutComicTimeline, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { ffmpeg, inspectMedia, mediaCapabilities, mediaProcess } from "../marketing-video/media.js";
import { captionAss } from "../marketing-video/subtitles.js";

export type ComicRenderSource = { path: string; durationMs: number };
export const COMIC_RENDER_PREMIX_BATCH = 32;
const fps = COMIC_RENDER_FPS;
const rate = 48_000;
const sec = (ms: number) => (ms / 1000).toFixed(6);
const frameSec = (frame: number) => (frame / fps).toFixed(6);
const stereo = `aresample=${rate},aformat=sample_fmts=fltp:channel_layouts=stereo`;
const delay = (ms: number) => `adelay=${ms * (rate / 1000)}S:all=1`;
const timebase = `settb=1/${fps},setpts=N`;

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

export function shouldPremixComicAudio(timeline: ComicTimeline): boolean {
  return timeline.video.length + timeline.voice.length + timeline.sfx.length + timeline.music.length > COMIC_RENDER_MAX_INPUTS;
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
    args.push("-threads", "1", "-protocol_whitelist", "file,pipe", "-f", entry.format, "-i", entry.path);
    graph.push(`[${index}:a:0]${entry.filter}[a${index}]`);
    mix.push(`[a${index}]`);
  });
  graph.push(`anullsrc=r=${rate}:cl=stereo:d=${duration}[silence]`);
  graph.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0[stem]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[stem]", "-t", duration,
    "-f", "wav", "-c:a", "pcm_f32le", "-ar", String(rate), "-ac", "2", output);
  return { output, inputCount: inputs.length, args };
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
  const finalStem = `stem-${track}.wav`;
  if (entries.length <= batchSize) {
    const pass = buildStemMixPass(
      entries.map(entry => ({
        path: entry.path,
        format: entry.format,
        filter: buildAudioItemFilter(entry.clip, entry.sourceDurationMs, entry.startMs),
      })),
      duration,
      finalStem,
    );
    return { passes: [pass], finalStem };
  }
  const passes: PremixPass[] = [];
  let stageFiles: string[] = [];
  for (let offset = 0, part = 0; offset < entries.length; offset += batchSize, part++) {
    const chunk = entries.slice(offset, offset + batchSize);
    const out = `stem-${track}-p0-${part}.wav`;
    passes.push(buildStemMixPass(
      chunk.map(entry => ({
        path: entry.path,
        format: entry.format,
        filter: buildAudioItemFilter(entry.clip, entry.sourceDurationMs, entry.startMs),
      })),
      duration,
      out,
    ));
    stageFiles.push(out);
  }
  let level = 1;
  while (stageFiles.length > batchSize) {
    const next: string[] = [];
    for (let offset = 0, part = 0; offset < stageFiles.length; offset += batchSize, part++) {
      const chunk = stageFiles.slice(offset, offset + batchSize);
      const out = `stem-${track}-p${level}-${part}.wav`;
      passes.push(buildStemMixPass(chunk.map(path => ({ path, format: "wav", filter: stereo })), duration, out));
      next.push(out);
    }
    stageFiles = next;
    level++;
  }
  passes.push(buildStemMixPass(stageFiles.map(path => ({ path, format: "wav", filter: stereo })), duration, finalStem));
  return { passes, finalStem };
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

export async function composeComicRender(timeline: ComicTimeline, inputs: {
  videos: ReadonlyMap<string, ComicRenderSource>; audio: ReadonlyMap<string, ComicRenderSource>;
}, signal: AbortSignal, options: { forcePremix?: boolean } = {}) {
  const issue = comicRenderIssue(timeline);
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
  for (const [key, source] of inputs.videos) videoSources.set(key, await probe(source, true, signal));
  for (const [key, source] of inputs.audio) audioSources.set(key, await probe(source, false, signal));
  const bounds = { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080] } as const;
  const [width, height] = bounds[timeline.aspectRatio];
  const layout = layoutComicTimeline(timeline);
  const duration = frameSec(comicFrame(layout.durationMs));
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
  const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const pad = `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  let picture = "[clip0]";
  for (const [index, clip] of timeline.video.entries()) {
    signal.throwIfAborted();
    const source = videoSources.get(clip.takeId);
    if (!source || source.durationMs !== clip.sourceDurationMs) throw new ComicRenderFailure("RENDER_SOURCE_CHANGED");
    const input = addInput(source.path, source.info.format);
    const item = layout.video[index];
    const frames = comicFrame(item.endMs) - comicFrame(item.startMs);
    const from = Math.floor(clip.inMs * fps / 1000);
    const normalize = `setpts=PTS-STARTPTS,fps=${fps},${scale},${pad},setsar=1,format=yuv444p,tpad=stop_mode=clone:stop_duration=${sec(source.durationMs)}`;
    graph.push(`[${input}:v:0]${normalize},trim=start_frame=${from}:end_frame=${from + frames},${timebase}[clip${index}]`);
    if (index) {
      const { kind } = clip.transitionIn;
      const overlap = comicFrame(layout.video[index - 1].endMs) - comicFrame(item.startMs);
      const blend = kind === "cut" ? "concat=n=2:v=1:a=0" :
        `xfade=transition=${kind === "black" ? "fadeblack" : "fade"}:duration=${frameSec(overlap)}:offset=${frameSec(comicFrame(item.startMs))}`;
      graph.push(`${picture}[clip${index}]${blend},${timebase}[join${index}]`);
      picture = `[join${index}]`;
    }
    if (!source.info.audio || clip.volume === 0) continue;
    const length = clip.outMs - clip.inMs;
    const fadeIn = clip.transitionIn.durationMs;
    const fadeOut = timeline.video[index + 1]?.transitionIn.durationMs ?? 0;
    const fades = [fadeIn && `afade=t=in:d=${sec(fadeIn)}`, fadeOut && `afade=t=out:st=${sec(length - fadeOut)}:d=${sec(fadeOut)}`].filter(Boolean);
    const filters = [stereo, `atrim=start=${sec(clip.inMs)}:end=${sec(clip.outMs)}`, "asetpts=N/SR/TB", `volume=${clip.volume}`, ...fades, delay(item.startMs)];
    graph.push(`[${input}:a:0]${filters.join(",")}[original${index}]`);
    mix.push(`[original${index}]`);
  }

  const premix = options.forcePremix || shouldPremixComicAudio(timeline);
  const folder = await mkdtemp(join(tmpdir(), "lot-comic-render-"));
  const dispose = () => rm(folder, { recursive: true, force: true });
  try {
    if (premix) {
      for (const [track, entries] of audioTrackEntries) {
        signal.throwIfAborted();
        const plan = planAudioStemPremix(track, entries, duration);
        for (const pass of plan.passes) {
          signal.throwIfAborted();
          await mediaProcess(ffmpeg(), pass.args, { cwd: folder, signal, timeoutMs: 300_000 });
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
    await mediaProcess(ffmpeg(), [...args, "-filter_complex", graph.join(";"), "-map", "[video]", "-map", "[audio]", "-t", duration,
      "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-crf", "20", "-maxrate", "8M", "-bufsize", "16M",
      "-c:a", "aac", "-b:a", "160k", "-ar", String(rate), "-movflags", "+faststart", "film.mp4"],
    { cwd: folder, signal, timeoutMs: 900_000 });
    const info = await inspectMedia(file, signal);
    if (!info.video || !info.audio || info.width !== width || info.height !== height || Math.abs(info.duration * 1000 - layout.durationMs) > 34) {
      throw new ComicRenderFailure("RENDER_OUTPUT_INVALID");
    }
    return { file, dispose };
  } catch (error) { await dispose(); throw error; }
}
