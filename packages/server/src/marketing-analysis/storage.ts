import { createHash } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AnalysisError } from "./errors.js";

export class AnalysisStorage {
  constructor(readonly root: string) {}
  async directory(owner: string, id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new AnalysisError("INVALID_PRIVATE_FILE");
    const root = resolve(this.root);
    const parts = [root, join(root, createHash("sha256").update(owner).digest("hex"))];
    parts.push(join(parts[1], id));
    for (const path of parts) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new AnalysisError("INVALID_PRIVATE_FILE");
    }
    return parts[2];
  }
  async remove(owner: string, id: string) { await rm(await this.directory(owner, id), { recursive: true, force: true }); }
}
