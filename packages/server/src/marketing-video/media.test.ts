import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectMedia, composeMarketingVideo } from "./media.js";
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
