import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESENTER_SEGMENT_GAP_MS, type PresenterDraft } from "@lot-agent/core/digital-presenter";
import { marketingCaptionLines, marketingCaptionOffset, type MarketingCaption, type MarketingCaptions } from "@lot-agent/core/marketing-video";
import { ffmpeg, inspectMedia, mediaProcess, narrationPauses } from "../marketing-video/media.js";
import { readImageInfo } from "../marketing-video/image-size.js";
import { captionAss, captionLayout, offsetCues, timeCaptions, type Cue } from "../marketing-video/subtitles.js";

const gap = PRESENTER_SEGMENT_GAP_MS / 1000;
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
/** Raw single-image demuxers: an image path is never read as a pattern or playlist. */
const IMAGE_DEMUXER = { "image/jpeg": "jpeg_pipe", "image/png": "png_pipe", "image/webp": "webp_pipe" } as const;

/** Output frame of image mode. wan2.2-s2v keeps the portrait's ratio. */
export function portraitFrame(ratio: PresenterDraft["ratio"], resolution: PresenterDraft["resolution"]) {
  const edge = resolution === "480P" ? 480 : 720;
  const [w, h] = ratio.split(":").map(Number);
  return { width: even(edge * w / Math.min(w, h)), height: even(edge * h / Math.min(w, h)) };
}

/** Center-crops the portrait to the chosen ratio at a fixed size within the vendor's 400–7000 px. */
export async function preparePortrait(input: string, output: string, ratio: PresenterDraft["ratio"], signal?: AbortSignal) {
  const info = await readImageInfo(input);
  if (!info || info.width < 64 || info.height < 64 || info.width > 8000 || info.height > 8000) throw new Error("人物肖像无法读取，请更换 JPG、PNG 或 WebP 图片。");
  const { width, height } = portraitFrame(ratio, "720P");
  await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-f", IMAGE_DEMUXER[info.mime], "-i", input,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`, "-frames:v", "1", "-q:v", "2", output], { signal, timeoutMs: 60_000 });
}

/** A face reference for VideoRetalk: a single JPEG, longest edge at most 1280 px. */
export async function prepareFace(input: string, output: string, signal?: AbortSignal) {
  const info = await readImageInfo(input);
  if (!info || info.width < 64 || info.height < 64 || Math.max(info.width, info.height) / Math.min(info.width, info.height) > 2) throw new Error("人脸参考图需为清晰的单人正脸照片，长宽比不超过 2。");
  await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-f", IMAGE_DEMUXER[info.mime], "-i", input,
    "-vf", "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,setsar=1", "-frames:v", "1", "-q:v", "2", output], { signal, timeoutMs: 60_000 });
}

/** The voice track of video mode: the takes back to back with a short pause between them. */
export async function buildTrack(takes: string[], output: string, signal?: AbortSignal) {
  const args = ["-nostdin", "-y", "-v", "error"];
  for (const take of takes) {
    const info = await inspectMedia(take, signal);
    if (!info.audio || info.video) throw new Error("配音文件不可用，请重新生成配音。");
    args.push("-protocol_whitelist", "file,pipe", "-f", info.format, "-i", take);
  }
  const parts = takes.map((_, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=mono${i < takes.length - 1 ? `,apad=pad_dur=${gap}` : ""}[a${i}]`);
  args.push("-filter_complex", `${parts.join(";")};${takes.map((_, i) => `[a${i}]`).join("")}concat=n=${takes.length}:v=0:a=1[a]`, "-map", "[a]", "-c:a", "pcm_s16le", output);
  await mediaProcess(ffmpeg(), args, { signal, timeoutMs: 120_000 });
  return (await inspectMedia(output, signal)).duration;
}

/** Width and height as shown: FFmpeg turns a rotated phone video upright before any filter. */
export function shownSize(info: { width: number; height: number; rotation: number }) {
  return Math.abs(info.rotation) % 180 === 90 ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}

/** HDR transfers: HLG (iPhone, including Dolby Vision on an HLG base) and PQ. */
const HDR_TRANSFERS = ["arib-std-b67", "smpte2084"];
export const isHdr = (info: { transfer?: string }) => HDR_TRANSFERS.includes(info.transfer ?? "");
/** HDR to BT.709 SDR as in BT.2408: reference white (203 nits) becomes SDR white, mid-tones keep their level and
 * brighter highlights roll off instead of clipping. The vendor reads pixels without the HDR tags, which left
 * iPhone footage grey and washed out. The source colorimetry is set on the frames, not only given to zscale:
 * with FFmpeg 5.1 (the Debian image) zscale otherwise finds no conversion path. HDR video is BT.2020. */
const hdrToSdr = (transfer: string) => [`setparams=color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`, "zscale=t=linear:npl=203",
  "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=mobius:param=0.8:desat=0", "zscale=t=bt709:m=bt709:r=tv", "format=yuv420p"];
const BT709 = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"];
export const HDR_UNAVAILABLE = "口播底片是 HDR 视频，当前视频处理工具无法转换。请在 iPhone「设置 > 相机 > 录制视频」关闭「HDR 视频」后重拍，或导出为 SDR 后上传。";
const hdrProbes = new Map<string, Promise<boolean>>();
/** Converts a tiny HLG frame the same way as real footage (FFmpeg with zimg). A failed probe is retried on the next call. */
export function hdrConversionAvailable(): Promise<boolean> {
  const key = ffmpeg();
  let probe = hdrProbes.get(key);
  if (!probe) {
    probe = mediaProcess(ffmpeg(), ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x64:d=0.1,format=yuv420p10le",
      "-vf", ["setparams=range=tv", ...hdrToSdr("arib-std-b67")].join(","), "-frames:v", "1", "-f", "null", "-"], { timeoutMs: 20_000 }).then(() => true, () => {
      console.warn("[digital-presenter] FFmpeg cannot convert HDR footage (zscale/tonemap)");
      hdrProbes.delete(key);
      return false;
    });
    hdrProbes.set(key, probe);
  }
  return probe;
}

/** Footage limits of VideoRetalk: 15–60 fps, each edge 640–2048 px. */
export function footageScale(width: number, height: number) {
  const short = Math.min(width, height); const long = Math.max(width, height);
  if (!short || long / short > 2048 / 640) return null;
  const factor = short < 640 ? 640 / short : long > 2048 ? 2048 / long : 1;
  return { width: even(width * factor), height: even(height * factor) };
}

/** Footage trimmed to the voice track, so the vendor never cuts the speech short or loops
 * the footage backwards. Re-encoded upright as silent 8-bit BT.709 H.264 within the vendor's size and rate limits. */
export async function prepareFootage(input: string, output: string, durationSec: number, signal?: AbortSignal) {
  const info = await inspectMedia(input, signal);
  if (!info.video) throw new Error("口播底片无法读取画面，请重新上传。");
  if (info.duration + 0.05 < durationSec) throw new Error(`口播底片需不短于配音（${durationSec.toFixed(1)} 秒），请补拍或精简文案。`);
  const shown = shownSize(info);
  const size = footageScale(shown.width, shown.height);
  if (!size) throw new Error("口播底片的宽高比过于狭长，请使用常规横屏或竖屏视频。");
  const hdr = isHdr(info);
  if (hdr && !await hdrConversionAvailable()) throw new Error(HDR_UNAVAILABLE);
  const filters = [...hdr ? hdrToSdr(info.transfer!) : [], `scale=${size.width}:${size.height}`, "setsar=1"];
  if (!Number.isFinite(info.fps) || info.fps < 15 || info.fps > 60) filters.push("fps=30");
  await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", info.format, "-i", input,
    "-map", "0:v:0", "-an", "-t", durationSec.toFixed(3), "-vf", filters.join(","), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", ...hdr ? BT709 : [],
    "-movflags", "+faststart", output],
  { signal, timeoutMs: 600_000 });
  const prepared = await inspectMedia(output, signal);
  if ((await stat(output)).size > 290 * 1024 * 1024) throw new Error("口播底片过大，请上传更短或更低码率的视频。");
  return prepared;
}

/** Captions to burn: each take's text, with the style, line breaks and offsets of `settings`. */
export interface PresenterCaptionInput { texts: string[]; settings?: MarketingCaptions }

/** Caption cues of take `index`, in seconds from the take's start, timed to its pauses and moved by
 * its offset. No line shows after `spanSec`, the take plus the pause that follows it. */
export async function takeCues(take: { path: string; format: string; speechSec: number }, index: number, captions: PresenterCaptionInput, spanSec: number, frame: { width: number; height: number }, signal?: AbortSignal): Promise<Cue[]> {
  const draft = { captions: captions.settings };
  const text = captions.texts[index];
  const lines = marketingCaptionLines(draft, index, text, captionLayout(frame.width, frame.height, captions.settings).maxCells);
  const cues = timeCaptions(lines, take.speechSec, spanSec, await narrationPauses(take.path, take.format, take.speechSec, signal));
  return offsetCues(cues, marketingCaptionOffset(draft, index, text), spanSec);
}
const filmCues = (cues: Cue[], shot: number, at: number): MarketingCaption[] =>
  cues.map(cue => ({ shot, start: Math.round((at + cue.start) * 100) / 100, end: Math.round((at + cue.end) * 100) / 100, text: cue.text }));

/** Image mode: one clip per take. Each clip keeps its own take as audio and holds its last
 * frame through the pause; every other clip is framed slightly closer, so the cuts read as edits.
 * `captions`, when given, are burned into each clip and returned in seconds of the film. */
export async function composeImageMode(input: { clips: string[]; takes: string[]; takeMs: number[]; captions?: PresenterCaptionInput; frame: { width: number; height: number }; signal?: AbortSignal }) {
  const folder = await mkdtemp(join(tmpdir(), "lot-presenter-"));
  const dispose = () => rm(folder, { recursive: true, force: true });
  try {
    const { width, height } = input.frame;
    let expected = 0;
    const burned: MarketingCaption[] = [];
    for (let i = 0; i < input.clips.length; i++) {
      const clip = await inspectMedia(input.clips[i], input.signal);
      const take = await inspectMedia(input.takes[i], input.signal);
      if (!clip.video || !take.audio) throw new Error("片段文件不可用，请重新生成该段。");
      const speech = input.takeMs[i] / 1000;
      if (clip.duration < speech - 0.5) throw new Error("生成片段短于配音，请重新生成该段。");
      const pause = i < input.clips.length - 1 ? gap : 0;
      const length = speech + pause;
      const start = expected;
      expected += length;
      const zoom = i % 2 ? "crop=iw*0.9:ih*0.9," : "";
      let captions = "";
      if (input.captions) {
        // The file name is fixed, never user text.
        const cues = await takeCues({ path: input.takes[i], format: take.format, speechSec: speech }, i, input.captions, length, input.frame, input.signal);
        await writeFile(join(folder, `${i}.ass`), captionAss(cues, width, height, input.captions.settings));
        burned.push(...filmCues(cues, i, start));
        captions = `,subtitles=filename=${i}.ass`;
      }
      await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", clip.format, "-i", input.clips[i],
        "-protocol_whitelist", "file,pipe", "-f", take.format, "-i", input.takes[i], "-map", "0:v:0", "-map", "1:a:0",
        "-vf", `${zoom}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=25,tpad=stop_mode=clone:stop_duration=${(pause + 1).toFixed(3)}${captions}`,
        "-af", "aresample=48000,apad", "-t", length.toFixed(3), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-threads", "2", `${i}.mp4`],
      { signal: input.signal, cwd: folder });
    }
    return { ...await joinParts(folder, input.clips.length, expected, input.signal), dispose, ...(input.captions ? { captions: burned } : {}) };
  } catch (error) { await dispose(); throw error; }
}

/** Video mode: the lip-synced clip with the local voice track in place of the vendor's re-encoded audio.
 * `captions`, when given, burns each take's script at the take's place in the track. */
export async function composeVideoMode(input: { clip: string; track: string; trackSec: number; captions?: PresenterCaptionInput & { takes: string[]; takeMs: number[] }; signal?: AbortSignal }) {
  const folder = await mkdtemp(join(tmpdir(), "lot-presenter-"));
  const dispose = () => rm(folder, { recursive: true, force: true });
  try {
    const clip = await inspectMedia(input.clip, input.signal);
    const track = await inspectMedia(input.track, input.signal);
    if (!clip.video || !track.audio) throw new Error("片段文件不可用，请重新生成。");
    if (clip.duration < input.trackSec - 1) throw new Error("生成视频短于配音，请重新生成。");
    const shown = shownSize(clip);
    const size = { width: even(shown.width), height: even(shown.height) };
    let captions = "";
    const burned: MarketingCaption[] = [];
    if (input.captions) {
      // The track holds the takes back to back with a pause between them; see buildTrack.
      let at = 0;
      for (let i = 0; i < input.captions.takes.length; i++) {
        const take = await inspectMedia(input.captions.takes[i], input.signal);
        const speechSec = input.captions.takeMs[i] / 1000;
        const span = i < input.captions.takes.length - 1 ? speechSec + gap : Math.max(speechSec, input.trackSec - at);
        burned.push(...filmCues(await takeCues({ path: input.captions.takes[i], format: take.format, speechSec }, i, input.captions, span, size, input.signal), i, at));
        at += speechSec + gap;
      }
      const cues = burned.map(cue => ({ start: cue.start, end: cue.end, text: cue.text }));
      await writeFile(join(folder, "0.ass"), captionAss(cues, size.width, size.height, input.captions.settings));
      captions = ",subtitles=filename=0.ass";
    }
    await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", clip.format, "-i", input.clip,
      "-protocol_whitelist", "file,pipe", "-f", track.format, "-i", input.track, "-map", "0:v:0", "-map", "1:a:0",
      "-vf", `scale=${size.width}:${size.height},setsar=1,tpad=stop_mode=clone:stop_duration=1${captions}`, "-af", "aresample=48000,apad",
      "-t", input.trackSec.toFixed(3), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-threads", "2", "-movflags", "+faststart", "0.mp4"],
    { signal: input.signal, cwd: folder, timeoutMs: 600_000 });
    return { ...await finish(join(folder, "0.mp4"), input.trackSec, input.signal), dispose, ...(input.captions ? { captions: burned } : {}) };
  } catch (error) { await dispose(); throw error; }
}

async function joinParts(folder: string, count: number, expected: number, signal?: AbortSignal) {
  await writeFile(join(folder, "parts.txt"), Array.from({ length: count }, (_, i) => `file '${i}.mp4'`).join("\n"));
  await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "1", "-i", "parts.txt", "-c", "copy", "-movflags", "+faststart", "final.mp4"],
    { cwd: folder, signal });
  return finish(join(folder, "final.mp4"), expected, signal);
}

async function finish(output: string, expected: number, signal?: AbortSignal) {
  const info = await inspectMedia(output, signal);
  if (!info.video || !info.audio || Math.abs(info.duration - expected) > 0.5) throw new Error("成片时长校验失败");
  const sizeBytes = (await stat(output)).size;
  if (sizeBytes > 200 * 1024 * 1024) throw new Error("成片过大，请降低清晰度或缩短文案。");
  // Left in the job's temporary folder and streamed to storage (see ComposedVideo).
  return { file: output, sizeBytes, durationSec: info.duration, width: info.width, height: info.height };
}
