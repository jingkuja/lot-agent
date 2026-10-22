import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep, join } from "node:path";
import { isMarketingDurationValid, type MarketingDraft, type MarketingSegment } from "@lot-agent/core/marketing-video";
import { captionAss, captionLayout, captionLines, timeCaptions, type Pause } from "./subtitles.js";

export function mediaProcess(binary: string, args: string[], opts: { signal?: AbortSignal; cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  opts.signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let killed = false;
    const kill = () => { killed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(kill, opts.timeoutMs ?? 300_000);
    opts.signal?.addEventListener("abort", kill, { once: true });
    const cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", kill); };
    child.stdout.on("data", (data) => { stdout += data; if (stdout.length > 1024 * 1024) kill(); });
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000); });
    child.once("error", () => { cleanup(); reject(new Error("视频合成工具不可用，请配置 FFmpeg 和 FFprobe。")); });
    child.once("close", (code) => {
      cleanup();
      if (opts.signal?.aborted) reject(new Error("任务已取消"));
      else if (code !== 0 || killed) reject(new Error("视频处理失败，请检查素材格式或稍后重试。"));
      else done(stdout);
    });
  });
}
export const ffmpeg = () => process.env.MARKETING_FFMPEG_PATH || "ffmpeg";
export const ffprobe = () => process.env.MARKETING_FFPROBE_PATH || "ffprobe";
// Everything composeMarketingVideo needs: H.264/AAC encoders and its filters.
const REQUIRED_ENCODERS = ["libx264", "aac"];
const REQUIRED_FILTERS = ["scale", "pad", "setsar", "fps", "aresample", "apad", "anullsrc", "amix", "volume", "asplit", "color"];
// Local captions for twin narration: libass rendering and pause detection.
const SUBTITLE_FILTERS = ["subtitles", "silencedetect", "ametadata"];
export const SUBTITLES_UNAVAILABLE = "视频合成工具不支持字幕烧录，请配置带 libass 的 FFmpeg 和中文字体。";
const PROBE_TTL_MS = 10 * 60_000;
type Capabilities = { composition: boolean; subtitles: boolean };
const probes = new Map<string, { at: number; result: Promise<Capabilities> }>();
/** `-version` alone accepts any program that exits 0. Check the encoders and
 * filters, then compose a tiny clip the same way as a real job, so a missing
 * codec fails before any clip is paid for. Cached by binary paths and versions.
 * `subtitles`: captions can be burned in (libass with a CJK-capable font setup). */
export async function mediaCapabilities(): Promise<Capabilities> {
  try {
    const versions = await Promise.all([mediaProcess(ffmpeg(), ["-version"], { timeoutMs: 5000 }), mediaProcess(ffprobe(), ["-version"], { timeoutMs: 5000 })]);
    const key = JSON.stringify([ffmpeg(), ffprobe(), ...versions.map(v => v.split("\n")[0])]);
    let probe = probes.get(key);
    if (!probe || Date.now() - probe.at > PROBE_TTL_MS) {
      probe = { at: Date.now(), result: probeComposition() };
      probes.set(key, probe);
      // A failed probe is retried on the next call instead of being cached.
      void probe.result.then(ok => { if (!ok.composition) probes.delete(key); });
    }
    return await probe.result;
  } catch { return { composition: false, subtitles: false }; }
}
async function probeComposition(): Promise<Capabilities> {
  const listed = (output: string) => new Set(output.split("\n").map(line => line.trim().split(/\s+/)[1]).filter(Boolean));
  const encoders = listed(await mediaProcess(ffmpeg(), ["-hide_banner", "-encoders"], { timeoutMs: 5000 }).catch(() => ""));
  const filters = listed(await mediaProcess(ffmpeg(), ["-hide_banner", "-filters"], { timeoutMs: 5000 }).catch(() => ""));
  const missing = [...REQUIRED_ENCODERS.filter(name => !encoders.has(name)), ...REQUIRED_FILTERS.filter(name => !filters.has(name))];
  if (missing.length) { console.warn("[marketing-video] FFmpeg is missing composition features", { missing }); return { composition: false, subtitles: false }; }
  const composition = await probeClip();
  const missingSubtitles = SUBTITLE_FILTERS.filter(name => !filters.has(name));
  if (missingSubtitles.length) console.warn("[marketing-video] FFmpeg cannot burn subtitles", { missing: missingSubtitles });
  return { composition, subtitles: composition && !missingSubtitles.length && await probeSubtitles() };
}
async function probeClip() {
  const folder = await mkdtemp(join(tmpdir(), "lot-marketing-probe-"));
  try {
    const encode = ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=0.4", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-filter_complex", "[0:v]scale=64:64:force_original_aspect_ratio=decrease,pad=64:64:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[v];[1:a]aresample=48000,apad,asplit[a1][a2];[a2]volume=0.5[b];[a1][b]amix=inputs=2:duration=first:normalize=0[a]",
      "-map", "[v]", "-map", "[a]", "-t", "0.4", "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "clip.mp4"];
    await mediaProcess(ffmpeg(), encode, { cwd: folder, timeoutMs: 20_000 });
    await writeFile(join(folder, "clips.txt"), "file 'clip.mp4'\nfile 'clip.mp4'");
    await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "1", "-i", "clips.txt", "-c", "copy", "-movflags", "+faststart", "joined.mp4"], { cwd: folder, timeoutMs: 20_000 });
    const info = await inspectMedia(join(folder, "joined.mp4"));
    if (!info.video || !info.audio) throw new Error("probe output incomplete");
    return true;
  } catch {
    console.warn("[marketing-video] FFmpeg composition probe failed");
    return false;
  } finally { await rm(folder, { recursive: true, force: true }); }
}
/** Burns a Chinese and English caption the way a real shot does. */
async function probeSubtitles() {
  const folder = await mkdtemp(join(tmpdir(), "lot-marketing-probe-"));
  try {
    await writeFile(join(folder, "probe.ass"), captionAss([{ start: 0, end: 0.4, text: "字幕 Subtitle 99" }], 64, 64));
    await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=0.4", "-vf", "subtitles=filename=probe.ass",
      "-t", "0.4", "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", "clip.mp4"], { cwd: folder, timeoutMs: 20_000 });
    return true;
  } catch {
    console.warn("[marketing-video] FFmpeg subtitle probe failed");
    return false;
  } finally { await rm(folder, { recursive: true, force: true }); }
}
export async function ownedAssetPath(root: string, asset: { type: string; storage_key: string; mime: string }) {
  const folder = await realpath(resolve(root, asset.type === "upload" ? "uploads" : "assets"));
  const path = await realpath(resolve(folder, asset.storage_key));
  if (!path.startsWith(folder + sep) || (await stat(path)).size > 300 * 1024 * 1024) throw new Error("素材原件不可用");
  return path;
}
export async function inspectMedia(path: string, signal?: AbortSignal) {
  // Choose a container before invoking FFmpeg: never let a disguised playlist
  // probe local files or URLs. The same forced demuxer is used for decoding.
  const handle = await open(path, "r");
  const header = Buffer.alloc(32);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const signature = header.toString("ascii");
  const format = signature.slice(4, 8) === "ftyp" ? "mov"
    : header.readUInt32BE(0) === 0x1a45dfa3 ? "matroska"
    : signature.startsWith("RIFF") && signature.slice(8, 12) === "WAVE" ? "wav"
    : signature.startsWith("ID3") || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) ? "mp3"
    : signature.startsWith("OggS") ? "ogg" : null;
  if (!format) throw new Error("素材格式或时长不支持");
  const value = JSON.parse(await mediaProcess(ffprobe(), ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", format, "-show_format", "-show_streams", "-of", "json", path], { signal, timeoutMs: 15000 }));
  const duration = Number(value.format?.duration);
  // Reject playlists and other formats capable of referencing arbitrary files.
  if (!/^(mov,mp4,m4a,3gp,3g2,mj2|matroska,webm|mp3|wav|ogg)$/.test(value.format?.format_name ?? "") || !Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error("素材格式或时长不支持");
  if (value.streams?.some((s: { width?: number; height?: number }) => (s.width ?? 0) > 7680 || (s.height ?? 0) > 7680)) throw new Error("素材分辨率过大");
  const video = value.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const [fpsNumerator, fpsDenominator = "1"] = String(video?.avg_frame_rate ?? "0/1").split("/");
  return { width: Number(video?.width ?? 0), height: Number(video?.height ?? 0), fps: Number(fpsNumerator) / Number(fpsDenominator), format, duration, audio: value.streams?.some((s: { codec_type: string }) => s.codec_type === "audio"), video: value.streams?.some((s: { codec_type: string }) => s.codec_type === "video") };
}
/** Silent stretches of a narration take, from FFmpeg's silencedetect. */
export async function narrationPauses(path: string, format: string, durationSec: number, signal?: AbortSignal): Promise<Pause[]> {
  const output = await mediaProcess(ffmpeg(), ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", format, "-i", path,
    "-af", "silencedetect=noise=-35dB:d=0.12,ametadata=mode=print:file=-", "-f", "null", "-"], { signal, timeoutMs: 30_000 });
  const pauses: Pause[] = [];
  let start: number | undefined;
  for (const line of output.split("\n")) {
    const match = /^lavfi\.silence_(start|end)=(-?[\d.]+)/.exec(line.trim());
    if (!match) continue;
    const at = Math.min(durationSec, Math.max(0, Number(match[2])));
    if (match[1] === "start") start = at;
    else if (start !== undefined) { pauses.push({ start, end: at }); start = undefined; }
  }
  if (start !== undefined) pauses.push({ start, end: durationSec });
  return pauses;
}

/** `narration`, when given, holds one audio file per clip that replaces the clip's own track.
 * `subtitles` burns each shot's confirmed copy as captions timed to its narration take;
 * the clips must be free of model-drawn text. */
export async function composeMarketingVideo(input: { files: string[]; segments: MarketingSegment[]; draft: MarketingDraft; music?: string; narration?: string[]; subtitles?: boolean; signal?: AbortSignal }) {
  const durationSec = input.segments.reduce((sum, segment) => sum + segment.durationSec, 0);
  if (!input.segments.length || input.segments.length > 15 || input.files.length !== input.segments.length || (input.narration && input.narration.length !== input.files.length) || (input.subtitles && !input.narration)
    || input.segments.some((segment, index) => segment.index !== index || !Number.isInteger(segment.durationSec) || segment.durationSec < 4 || segment.durationSec > 15)
    || !isMarketingDurationValid(input.draft.durationSec, durationSec)) throw new Error("视频分段配置不完整");
  const folder = await mkdtemp(join(tmpdir(), "lot-marketing-"));
  try {
    const edge = input.draft.quality === "1080p" ? 1080 : 720;
    const [rw, rh] = input.draft.ratio.split(":").map(Number);
    const width = Math.round(edge * rw / Math.min(rw, rh) / 2) * 2;
    const height = Math.round(edge * rh / Math.min(rw, rh) / 2) * 2;
    for (let i = 0; i < input.files.length; i++) {
      const info = await inspectMedia(input.files[i], input.signal);
      const duration = input.segments[i].durationSec;
      if (!info.video || info.duration < duration - 0.25) throw new Error("生成片段时长不足，请重新生成该片段。");
      const args = ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", info.format, "-i", input.files[i]];
      let audio = info.audio ? "0:a:0" : "1:a:0";
      let captions = "";
      if (input.narration) {
        const voice = await inspectMedia(input.narration[i], input.signal);
        // Never cut a confirmed line short: the clip must outlast it.
        if (!voice.audio || voice.video || voice.duration > duration - 0.1) throw new Error("配音与镜头时长不一致，请重新生成配音。");
        args.push("-protocol_whitelist", "file,pipe", "-f", voice.format, "-i", input.narration[i]);
        audio = "1:a:0";
        if (input.subtitles) {
          // Burned while the clip is re-encoded anyway; the file name is fixed, never user text.
          const lines = captionLines(input.segments[i].script, captionLayout(width, height).maxCells);
          const cues = timeCaptions(lines, voice.duration, duration, await narrationPauses(input.narration[i], voice.format, voice.duration, input.signal));
          await writeFile(join(folder, `${i}.ass`), captionAss(cues, width, height));
          captions = `,subtitles=filename=${i}.ass`;
        }
      } else if (!info.audio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      args.push("-map", "0:v:0", "-map", audio, "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25${captions}`, "-af", "aresample=48000,apad", "-t", String(duration), "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-threads", "2", `${i}.mp4`);
      await mediaProcess(ffmpeg(), args, { signal: input.signal, cwd: folder });
    }
    await writeFile(join(folder, "clips.txt"), input.files.map((_, i) => `file '${i}.mp4'`).join("\n"));
    await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "1", "-i", "clips.txt", "-c", "copy", "joined.mp4"], { cwd: folder, signal: input.signal });
    const args = ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", "joined.mp4"];
    if (input.music) {
      const music = await inspectMedia(input.music, input.signal);
      if (!music.audio) throw new Error("背景音乐不含音轨");
      args.push("-stream_loop", "-1", "-protocol_whitelist", "file,pipe", "-f", music.format, "-i", input.music, "-filter_complex", `[1:a]volume=${input.draft.musicVolume}[bgm];[0:a][bgm]amix=inputs=2:duration=first:normalize=0[a]`, "-map", "0:v:0", "-map", "[a]");
    }
    // Captions are burned into the shots above, or drawn by the video model.
    args.push("-c:v", "copy");
    args.push("-c:a", "aac", "-t", String(durationSec), "-threads", "2", "-movflags", "+faststart", "final.mp4");
    await mediaProcess(ffmpeg(), args, { cwd: folder, signal: input.signal });
    const output = join(folder, "final.mp4");
    const info = await inspectMedia(output, input.signal);
    if (Math.abs(info.duration - durationSec) > 0.3) throw new Error("成片时长校验失败");
    if ((await stat(output)).size > 200 * 1024 * 1024) throw new Error("成片超过知识库存储限制，请降低清晰度。");
    return { body: await readFile(output), durationSec: info.duration, width, height };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
