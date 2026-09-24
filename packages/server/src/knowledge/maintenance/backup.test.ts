import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBackup, fileHash } from "./backup.js";
it("rejects a modified database dump before any restore can start", async () => {
  const path = await mkdtemp(join(tmpdir(), "knowledge-backup-check-"));
  try {
    await writeFile(join(path,"database.dump"), "snapshot");
    const manifest = { version: 1, files: [], databaseSha256: await fileHash(join(path,"database.dump")) };
    await writeFile(join(path,"manifest.json"), JSON.stringify(manifest));
    await expect(verifyBackup(path)).resolves.toMatchObject({ version: 1 });
    await writeFile(join(path,"database.dump"), "corrupt");
    await expect(verifyBackup(path)).rejects.toThrow("checksum");
  } finally { await rm(path,{recursive:true,force:true}); }
});
