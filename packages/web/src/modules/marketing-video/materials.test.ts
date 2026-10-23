import { afterEach, describe, expect, it, vi } from "vitest";
import { GROK_MARKETING_PROFILE, MARKETING_MATERIAL_RULES, MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { readImageSize, readMediaDuration } from "../../lib/video-references.js";
import { checkMaterial, materialAccept, materialRule, voiceUploadLabel } from "./materials.js";

vi.mock("../../lib/video-references.js", () => ({ readImageSize: vi.fn(), readMediaDuration: vi.fn(), readMediaMetadata: vi.fn(), klingReferenceVideoIssue: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const draft = MarketingDraftSchema.parse({});
const file = (type: string, bytes = 1) => new File([new Uint8Array(bytes)], "sample", { type });
const check = (sample: File, slot: "voice" | "portrait" | "music") => checkMaterial(sample, slot, draft, GROK_MARKETING_PROFILE);

describe("studio material checks", () => {
  it("accepts every voice format the server accepts and checks the length", async () => {
    vi.mocked(readMediaDuration).mockResolvedValue(8);
    for (const type of MARKETING_MATERIAL_RULES.voice.formats) await expect(check(file(type), "voice")).resolves.toBeUndefined();
    vi.mocked(readMediaDuration).mockResolvedValue(16);
    await expect(check(file("audio/mp4"), "voice")).rejects.toThrow("声音样例时长需为 2–15 秒");
  });
  it("refuses voice and image files outside the shared rules before reading them", async () => {
    await expect(check(file("audio/webm"), "voice")).rejects.toThrow("声音样例支持 MP3、WAV、M4A，最大 15 MB。");
    await expect(check(file("audio/mpeg", MARKETING_MATERIAL_RULES.voice.maxBytes + 1), "voice")).rejects.toThrow("最大 15 MB");
    await expect(check(file("image/gif"), "portrait")).rejects.toThrow("图片支持 JPG、PNG、WebP，最大 20 MB。");
    await expect(check(file("image/png", MARKETING_MATERIAL_RULES.image.maxBytes + 1), "portrait")).rejects.toThrow("最大 20 MB");
    expect(readMediaDuration).not.toHaveBeenCalled();
    expect(readImageSize).not.toHaveBeenCalled();
  });
  it("offers the shared formats in the file pickers and hints", () => {
    expect(materialAccept("voice")).toBe(MARKETING_MATERIAL_RULES.voice.formats.join(","));
    expect(materialAccept("scene")).toBe("image/jpeg,image/png,image/webp");
    expect(materialRule("music")).toBe("背景音乐支持 MP3、WAV、M4A，最大 30 MB。");
    expect(materialRule("video")).toBe("参考视频支持 MP4、MOV，最大 150 MB。");
    expect(voiceUploadLabel()).toBe("上传声音样例（2–15 秒）");
  });
});
