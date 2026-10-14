import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisCallLedger, ModelStepReceipt } from "./models.js";
import { AnalysisError } from "./errors.js";

interface ProbeRecord { stepId: string; inputHash: string; model: string; images: number; receipt?: ModelStepReceipt }
/** Phase-one operator probe only, not the multi-user production job store.
 * fsync the intent before HTTP; never replay an interrupted/malformed step.
 * The caller must hold the owner-scoped probe lock for this run directory. */
export class ProbeCallLedger implements AnalysisCallLedger {
  private pending = Promise.resolve();
  constructor(private readonly directory: string, private readonly account: (stepId: string, model: string, receipt: ModelStepReceipt) => Promise<void>, private readonly limits = { calls: 5, images: 6 }) {}
  private path(stepId: string) { return join(this.directory, `${createHash("sha256").update(stepId).digest("hex")}.json`); }
  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.pending; let unlock!: () => void;
    this.pending = new Promise<void>(resolve => { unlock = resolve; });
    await prior;
    try { return await work(); } finally { unlock(); }
  }
  async begin(stepId: string, inputHash: string, model: string, images: number) {
    return this.serialized(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      let old: ProbeRecord | undefined;
      try { old = JSON.parse(await readFile(this.path(stepId), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (old) {
        if (old.inputHash !== inputHash || old.model !== model) throw new AnalysisError("STEP_INPUT_CHANGED", 409);
        if (!old.receipt || old.receipt.outcome === "request_unknown") throw new AnalysisError("REQUEST_UNKNOWN", 409);
        await this.account(stepId, model, old.receipt);
        return old.receipt;
      }
      const records = await this.records();
      if (records.length >= this.limits.calls || records.reduce((sum, row) => sum + row.images, 0) + images > this.limits.images) throw new AnalysisError("MODEL_BUDGET_EXHAUSTED");
      const handle = await open(this.path(stepId), "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ stepId, inputHash, model, images })); await handle.sync(); } finally { await handle.close(); }
      await this.syncDirectory();
      return null;
    });
  }
  async finish(stepId: string, receipt: ModelStepReceipt) {
    await this.serialized(async () => {
      const path = this.path(stepId); const old: ProbeRecord = JSON.parse(await readFile(path, "utf8"));
      const staging = `${path}.${randomUUID()}.tmp`;
      const handle = await open(staging, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ ...old, receipt })); await handle.sync(); }
      finally { await handle.close(); }
      try { await rename(staging, path); await this.syncDirectory(); }
      finally { await rm(staging, { force: true }); }
      // Checkpoint first. Idempotent account() can recover a crash here.
      await this.account(stepId, old.model, receipt);
    });
  }
  async records(): Promise<ProbeRecord[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    return Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => JSON.parse(await readFile(join(this.directory, name), "utf8"))));
  }
  private async syncDirectory() {
    const handle = await open(this.directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
