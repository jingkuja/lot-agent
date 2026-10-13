import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectMedia } from "./media.js";

describe("marketing media safety", () => {
  it("rejects a disguised playlist before spawning a media decoder", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-media-test-"));
    try {
      const path = join(root, "fake.mp4");
      await writeFile(path, "#EXTM3U\n#EXTINF:15,\nfile:///etc/passwd");
      await expect(inspectMedia(path)).rejects.toThrow("素材格式");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
