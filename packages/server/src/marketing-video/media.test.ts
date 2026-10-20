import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectMedia, composeMarketingVideo, mediaCapabilities } from "./media.js";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";

describe("marketing media safety", () => {
  it.each([59, 66])("rejects a %ds composition for a 60s target before opening media", async total => {
    const segments = Array.from({ length: 5 }, (_, index) => ({ index, script: "欢迎", durationSec: Math.floor(total / 5) + (index < total % 5 ? 1 : 0) }));
    await expect(composeMarketingVideo({ draft: MarketingDraftSchema.parse({ durationSec: 60 }), files: segments.map(() => "/missing.mp4"), segments })).rejects.toThrow("视频分段配置不完整");
  });
  it("rejects a disguised playlist before spawning a media decoder", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-media-test-"));
    try {
      const path = join(root, "fake.mp4");
      await writeFile(path, "#EXTM3U\n#EXTINF:15,\nfile:///etc/passwd");
      await expect(inspectMedia(path)).rejects.toThrow("素材格式");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("composition readiness probe", () => {
  const ffmpegInstalled = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
  it("rejects a program that only answers -version", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-probe-test-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fake = join(root, "fake-ffmpeg");
      await writeFile(fake, "#!/bin/sh\n[ \"$1\" = -version ] && echo 'ffmpeg version fake' && exit 0\nexit 0\n");
      await chmod(fake, 0o755);
      vi.stubEnv("MARKETING_FFMPEG_PATH", fake); vi.stubEnv("MARKETING_FFPROBE_PATH", fake);
      expect(await mediaCapabilities()).toEqual({ composition: false });
      expect(warn).toHaveBeenCalledWith("[marketing-video] FFmpeg is missing composition features", { missing: expect.arrayContaining(["libx264", "aac", "amix"]) });
    } finally { vi.unstubAllEnvs(); warn.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(!ffmpegInstalled)("composes a probe clip with the installed FFmpeg", async () => {
    expect(await mediaCapabilities()).toEqual({ composition: true });
  }, 30_000);
});
