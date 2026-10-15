import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, truncate, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { AnalysisStorage } from "./storage.js";

it("counts retained bytes and reserves space for concurrent work, without following symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "lot-storage-test-"));
  const storage = new AnalysisStorage(root);
  const owner = "owner";
  try {
    vi.stubEnv("MARKETING_ANALYSIS_OWNER_BYTES", String(2 * 1024 ** 3));
    vi.stubEnv("MARKETING_ANALYSIS_MIN_FREE_BYTES", String(512 * 1024 ** 2));
    const directory = await storage.directory(owner, randomUUID());
    const file = join(directory, "retained.jpg");
    await writeFile(file, "fixture");
    await storage.assertCapacity(owner, 0, 0);
    // Sparse file: tests accounting without allocating gigabytes on disk.
    await truncate(file, 1.6 * 1024 ** 3 | 0);
    await expect(storage.assertCapacity(owner, 0, 0)).rejects.toThrow("ANALYSIS_STORAGE_LIMIT");
    await truncate(file, 1024);
    await expect(storage.assertCapacity(owner, 3, 3)).rejects.toThrow("ANALYSIS_STORAGE_LIMIT");
    vi.stubEnv("MARKETING_ANALYSIS_MIN_FREE_BYTES", String(Number.MAX_SAFE_INTEGER));
    await expect(storage.assertCapacity(owner, 0, 0)).rejects.toThrow("ANALYSIS_DISK_LOW");
    const stranger = join(root, createHash("sha256").update("stranger").digest("hex"));
    await symlink(directory, stranger);
    await expect(storage.assertCapacity("stranger", 0, 0)).rejects.toThrow("INVALID_PRIVATE_FILE");
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it.each(["not-a-number", "-1", "1024", "1.5"])("rejects invalid configured storage thresholds: %s", async value => {
  const root = await mkdtemp(join(tmpdir(), "lot-storage-config-"));
  try {
    for (const key of ["MARKETING_ANALYSIS_OWNER_BYTES", "MARKETING_ANALYSIS_MIN_FREE_BYTES"]) {
      vi.stubEnv(key, value);
      await expect(new AnalysisStorage(root).assertCapacity("owner", 0, 0)).rejects.toThrow("ANALYSIS_CONFIG_REQUIRED");
      vi.unstubAllEnvs();
    }
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
