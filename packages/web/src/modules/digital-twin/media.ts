import { fileMime } from "../knowledge/api.js";
import { readMediaDuration } from "../../lib/video-references.js";

export type TwinKind = "voice" | "portrait";
export const twinTag = (kind: TwinKind) => `digital-twin:${kind}`;
export const MAX_VOICE_SECONDS = 15;

export async function validateTwinFile(file: File, kind: TwinKind): Promise<void> {
  const mime = fileMime(file);
  const allowed = kind === "voice" ? ["audio/mpeg", "audio/wav"] : ["image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(mime)) throw new Error(kind === "voice" ? "声音样例仅支持 MP3、WAV" : "肖像仅支持 JPG、PNG、WebP");
  if (!file.size || file.size > (kind === "voice" ? 15 : 20) * 1024 * 1024) {
    throw new Error(kind === "voice" ? "声音样例不能为空或超过 15 MB" : "肖像不能为空或超过 20 MB");
  }
  if (kind === "voice") {
    const duration = await readMediaDuration(file);
    if (!Number.isFinite(duration) || duration < 2 || duration > MAX_VOICE_SECONDS) throw new Error("声音样例时长需为 2–15 秒");
  }
}

/** PCM16 mono WAV, compatible with video providers; clips only newly recorded audio. */
export function encodeWave(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  if (!channels.length || !Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("无法读取录音");
  const count = Math.min(...channels.map((channel) => channel.length), sampleRate * MAX_VOICE_SECONDS);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + count * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const value = Math.max(-1, Math.min(1, channels.reduce((sum, ch) => sum + ch[i], 0) / channels.length));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

export async function recordingToWave(blob: Blob): Promise<File> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
    return new File([encodeWave(channels, audio.sampleRate)], `voice-${Date.now()}.wav`, { type: "audio/wav" });
  } finally { await context.close(); }
}

export function captureError(error: unknown): string {
  if (error instanceof DOMException) {
    if (["NotAllowedError", "SecurityError"].includes(error.name)) return "无法访问设备，请在浏览器和系统设置中允许麦克风或摄像头权限。";
    if (error.name === "NotFoundError") return "未找到麦克风或摄像头，请连接设备后重试。";
    if (error.name === "NotReadableError") return "设备正被占用或无法启动，请关闭其他使用设备的应用后重试。";
  }
  return error instanceof Error ? error.message : "采集失败，请重试或上传文件。";
}
