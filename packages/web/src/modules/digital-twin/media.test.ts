import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWave, validateTwinFile, captureError } from "./media.js";
import { readMediaDuration } from "../../lib/video-references.js";
vi.mock("../../lib/video-references.js", () => ({ readMediaDuration: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("digital twin voice samples", () => {
  it("writes playable mono PCM16 WAV with clipping and stereo downmix", () => {
    const buffer = encodeWave([new Float32Array([-2, 0.5, 2]), new Float32Array([-2, -0.5, 2])], 24000);
    const view = new DataView(buffer);
    expect(new TextDecoder().decode(buffer.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(buffer.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(40, true)).toBe(6);
    expect([0, 1, 2].map((i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, 0, 32767]);
  });
  it("caps recordings at 15 seconds so timer delays cannot create oversized references", () => {
    const view = new DataView(encodeWave([new Float32Array(16000 * 16)], 16000));
    expect(view.getUint32(40, true) / 2 / 16000).toBe(15);
  });
  it("rejects unsupported, empty and oversized voice samples before decoding", async () => {
    for (const file of [new File(["a"], "voice.webm"), new File([], "voice.wav"), new File([new Uint8Array(15 * 1024 * 1024 + 1)], "voice.mp3")]) {
      await expect(validateTwinFile(file, "voice")).rejects.toThrow();
    }
    expect(readMediaDuration).not.toHaveBeenCalled();
  });
  it("accepts only finite 2–15 second samples and propagates decode failure", async () => {
    const file = new File(["voice"], "sample.wav", { type: "audio/wav" });
    for (const duration of [2, 15]) {
      vi.mocked(readMediaDuration).mockResolvedValueOnce(duration);
      await expect(validateTwinFile(file, "voice")).resolves.toBeUndefined();
    }
    for (const duration of [0, 1.99, 15.01, Infinity, NaN]) {
      vi.mocked(readMediaDuration).mockResolvedValueOnce(duration);
      await expect(validateTwinFile(file, "voice")).rejects.toThrow("2–15");
    }
    vi.mocked(readMediaDuration).mockRejectedValueOnce(new Error("decode failed"));
    await expect(validateTwinFile(file, "voice")).rejects.toThrow("decode failed");
  });
  it("does not accept audio as a portrait or active image formats", async () => {
    await expect(validateTwinFile(new File(["x"], "portrait.svg"), "portrait")).rejects.toThrow();
    await expect(validateTwinFile(new File(["x"], "voice.mp3"), "portrait")).rejects.toThrow();
    await expect(validateTwinFile(new File(["x"], "portrait.jpg"), "portrait")).resolves.toBeUndefined();
    expect(readMediaDuration).not.toHaveBeenCalled();
  });
  it("explains permission denial, missing and busy devices", () => {
    expect(captureError(new DOMException("", "NotAllowedError"))).toContain("权限");
    expect(captureError(new DOMException("", "NotFoundError"))).toContain("未找到");
    expect(captureError(new DOMException("", "NotReadableError"))).toContain("占用");
  });
});
