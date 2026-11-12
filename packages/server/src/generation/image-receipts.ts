import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type {
  ImageCallReceipt, ImageCallStore, ImageGenerationProvider, ImageGenerationRequest, GenerationCallOptions, CreateResult, PollResult,
} from "@lot-agent/core";

export class ImageResultUnknown extends Error {
  readonly errorCode = "IMAGE_RESULT_UNKNOWN";
  constructor() { super("IMAGE_RESULT_UNKNOWN"); this.name = "UnrecoverableError"; }
}

/** One instance is bound to a single user/task. Nothing in the model's request selects its receipt owner. */
export class DurableImageProvider implements ImageGenerationProvider {
  constructor(private provider: ImageGenerationProvider, private store: ImageCallStore, private fingerprint: string) {}

  async create(request: ImageGenerationRequest, options?: GenerationCallOptions): Promise<CreateResult> {
    const slot = options?.slot ?? 0;
    options?.signal?.throwIfAborted();
    const claimed = await this.store.claim(slot, this.fingerprint);
    if (!claimed) {
      const receipt = await this.store.get(slot);
      if (!receipt || receipt.fingerprint !== this.fingerprint) throw new ImageResultUnknown();
      if (receipt.state === "completed" || receipt.state === "submitted") {
        return { taskId: `receipt:${slot}`, status: receipt.state, progress: receipt.result?.progress ?? 0 };
      }
      if (receipt.state === "failed") throw Object.assign(new Error(receipt.error ?? "IMAGE_GENERATION_FAILED"), { name: "UnrecoverableError" });
      throw new ImageResultUnknown();
    }
    let created: CreateResult;
    try {
      created = await this.provider.create(request, options);
    } catch (error) {
      const e = (error ?? {}) as { confirmedRejection?: boolean; httpStatus?: number };
      const rejected = e.confirmedRejection === true || (!!e.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 408);
      const safe = /CONTENT_BLOCKED|REAL_PERSON_REJECTED/.exec(error instanceof Error ? error.message : "")?.[0] ?? "IMAGE_GENERATION_FAILED";
      try {
        await this.store.save(slot, { fingerprint: this.fingerprint, state: rejected ? "failed" : "unknown", error: safe });
      } catch {
        throw new ImageResultUnknown();
      }
      if (!rejected) throw new ImageResultUnknown();
      throw Object.assign(new Error(safe), { name: "UnrecoverableError" });
    }
    // Failure to store an accepted response leaves submitting in place: another worker must never re-POST it.
    try {
      await this.store.save(slot, {
        fingerprint: this.fingerprint, state: created.result ? "completed" : "submitted",
        vendorId: created.result ? undefined : created.taskId, result: created.result,
      });
    } catch {
      throw new ImageResultUnknown();
    }
    return { taskId: `receipt:${slot}`, status: created.result ? "completed" : "submitted", progress: created.progress };
  }

  async poll(id: string): Promise<PollResult> {
    if (/^images_/.test(id)) throw new ImageResultUnknown();
    const match = /^receipt:(\d+)$/.exec(id);
    if (!match) return this.provider.poll(id); // Real async IDs saved before the receipt migration.
    const slot = Number(match[1]);
    const receipt = await this.store.get(slot);
    if (!receipt || receipt.fingerprint !== this.fingerprint) throw new ImageResultUnknown();
    if (receipt.result) return receipt.result;
    if (receipt.state !== "submitted" || !receipt.vendorId) throw new ImageResultUnknown();
    const result = await this.provider.poll(receipt.vendorId);
    if (result.status === "completed") await this.store.save(slot, { ...receipt, state: "completed", result });
    return result;
  }
}

const LOCAL = /^image-receipt:\/\/([0-9a-f-]{36})\/(\d+)\/(\d+(?:-[0-9a-f]{64})?)$/;
export class PgImageCallStore implements ImageCallStore {
  private claimId = randomUUID();
  constructor(private pool: Pool, private root: string, private owner: string, private taskId: string) {}
  async claim(slot: number, fingerprint: string) {
    const result = await this.pool.query(`INSERT INTO image_call_receipts(task_id,user_id,slot,fingerprint,claim_id,state)
      SELECT id,user_id,$3,$4,$5,'submitting' FROM tasks WHERE id=$1 AND user_id=$2 AND status='running'
      ON CONFLICT DO NOTHING RETURNING task_id`, [this.taskId, this.owner, slot, fingerprint, this.claimId]);
    return !!result.rowCount;
  }
  async get(slot: number): Promise<ImageCallReceipt | null> {
    const { rows } = await this.pool.query(`SELECT state,fingerprint,vendor_id AS "vendorId",result,error
      FROM image_call_receipts WHERE task_id=$1 AND user_id=$2 AND slot=$3`, [this.taskId, this.owner, slot]);
    return rows[0] ?? null;
  }
  async save(slot: number, receipt: ImageCallReceipt) {
    let result = receipt.result;
    if (result) {
      const sources = result.urls ?? (result.url ? [result.url] : []);
      const urls: string[] = [];
      for (const [index, source] of sources.entries()) {
        if (!source.startsWith("data:")) { urls.push(source); continue; }
        const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(source);
        if (!match || match[2].length > 42 * 1024 * 1024) throw new Error("Invalid inline image result");
        const folder = join(this.root, this.taskId, String(slot));
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const body = Buffer.from(match[2], "base64");
        const name = `${index}-${createHash("sha256").update(match[1]).update(body).digest("hex")}`;
        const file = join(folder, name);
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, body, { mode: 0o600 });
        await rename(temp, file);
        await writeFile(`${file}.mime`, match[1], { mode: 0o600 });
        urls.push(`image-receipt://${this.taskId}/${slot}/${name}`);
      }
      result = { ...result, url: urls[0], urls };
    }
    const saved = await this.pool.query(`UPDATE image_call_receipts SET state=$4,vendor_id=$5,result=$6,error=$7,updated_at=now()
      WHERE task_id=$1 AND user_id=$2 AND slot=$3 AND fingerprint=$8
      AND ((claim_id=$9 AND state='submitting') OR (state='submitted' AND $4='completed')) RETURNING task_id`,
    [this.taskId, this.owner, slot, receipt.state, receipt.vendorId ?? null, result ?? null, receipt.error ?? null,
      receipt.fingerprint, this.claimId]);
    if (!saved.rowCount) {
      const current = await this.get(slot);
      if (current?.state !== "completed" || current.fingerprint !== receipt.fingerprint) throw new ImageResultUnknown();
    }
  }
  async read(url: string): Promise<{ body: Buffer; mime: string }> {
    const parts = LOCAL.exec(url);
    if (!parts) throw new Error("Invalid image receipt reference");
    const [, task, slot, index] = parts;
    const { rows } = await this.pool.query(`SELECT result FROM image_call_receipts WHERE task_id=$1 AND user_id=$2 AND slot=$3`,
      [task, this.owner, Number(slot)]);
    if (!rows[0]?.result?.urls?.includes(url)) throw new Error("Image receipt not found");
    const file = join(this.root, task, slot, index);
    return { body: await readFile(file), mime: await readFile(`${file}.mime`, "utf8") };
  }
}

export function imageCallFingerprint(input: unknown, model: string, scope: string) {
  return createHash("sha256").update(JSON.stringify([input, model, scope])).digest("hex");
}
