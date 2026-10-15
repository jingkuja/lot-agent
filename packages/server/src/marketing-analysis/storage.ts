import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, rm, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AnalysisError } from "./errors.js";
import { ANALYSIS_LIMITS } from "@lot-agent/core/marketing-analysis";

export class AnalysisStorage {
  constructor(readonly root: string) {}
  async assertCapacity(owner: string, pending: number, globalPending: number) {
    const ownerLimit = Number(process.env.MARKETING_ANALYSIS_OWNER_BYTES ?? 2 * 1024 ** 3);
    const freeMinimum = Number(process.env.MARKETING_ANALYSIS_MIN_FREE_BYTES ?? 1024 ** 3);
    if (![ownerLimit, freeMinimum].every(n => Number.isSafeInteger(n) && n >= ANALYSIS_LIMITS.temporaryBytes)) throw new AnalysisError("ANALYSIS_CONFIG_REQUIRED", 503);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new AnalysisError("INVALID_PRIVATE_FILE");
    const scan = async (path: string): Promise<number> => {
      let info;
      try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
      if (info.isSymbolicLink()) throw new AnalysisError("INVALID_PRIVATE_FILE");
      if (!info.isDirectory()) return info.size;
      let bytes = 0;
      for (const name of await readdir(path)) bytes += await scan(join(path, name));
      return bytes;
    };
    const bytes = await scan(join(resolve(this.root), createHash("sha256").update(owner).digest("hex")));
    if (bytes + (pending + 1) * ANALYSIS_LIMITS.temporaryBytes > ownerLimit) throw new AnalysisError("ANALYSIS_STORAGE_LIMIT", 409);
    const disk = await statfs(this.root);
    if (disk.bavail * disk.bsize < freeMinimum + (globalPending + 1) * ANALYSIS_LIMITS.temporaryBytes) throw new AnalysisError("ANALYSIS_DISK_LOW", 503);
  }
  async uploadDirectory(owner: string, id: string) { return this.directory(owner, id, "uploads"); }
  async removeUpload(owner: string, id: string) { await rm(await this.uploadDirectory(owner, id), { recursive: true, force: true }); }
  async directory(owner: string, id: string, scope?: "uploads") {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new AnalysisError("INVALID_PRIVATE_FILE");
    const root = resolve(this.root);
    const parts = [root, join(root, createHash("sha256").update(owner).digest("hex"))];
    if (scope) parts.push(join(parts[1], scope));
    parts.push(join(parts.at(-1)!, id));
    for (const path of parts) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new AnalysisError("INVALID_PRIVATE_FILE");
    }
    return parts.at(-1)!;
  }
  async remove(owner: string, id: string) { await rm(await this.directory(owner, id), { recursive: true, force: true }); }
}
