import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { fetchPublicBinary, type ImageGenerationProvider, type ReferenceMedia } from "@lot-agent/core";
import { COMIC_IMAGE_SIZES } from "@lot-agent/core/comic-drama";
import { DurableImageProvider, imageCallFingerprint, ImageResultUnknown, PgImageCallStore } from "../generation/image-receipts.js";
import { imageInfo } from "../marketing-video/image-size.js";
import { comicJobLockKey, PgComicGeneration } from "./generation-repository.js";
import type { ComicMediaLibrary } from "./media-library.js";

const maxBytes = 20 * 1024 * 1024;
type Dependencies = {
  pool: Pool;
  receiptPath: string;
  media: ComicMediaLibrary;
  provider: (owner: string, model: string) => Promise<ImageGenerationProvider>;
  download?: typeof fetchPublicBinary;
  pollIntervalMs?: number;
};

export async function runComicImageGeneration(deps: Dependencies, job: { id: string; userId: string }, signal: AbortSignal) {
  return withComicGenerationLock(deps.pool, job.id, () => runTakes(deps, job, signal));
}

export async function withComicGenerationLock<T>(pool: Pool, taskId: string, run: () => Promise<T>) {
  const connection = await pool.connect();
  const lockKey = comicJobLockKey(taskId);
  let locked = false;
  try {
    const { rows } = await connection.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lockKey]);
    locked = rows[0].locked;
    if (!locked) throw Object.assign(new Error("COMIC_WORKER_BUSY"), { errorCode: "COMIC_WORKER_BUSY" });
    return await run();
  } finally {
    let releaseError: Error | undefined;
    if (locked) {
      await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]).catch(() => {
        releaseError = new Error("Could not release comic generation task lock");
      });
    }
    connection.release(releaseError);
  }
}

async function runTakes(deps: Dependencies, job: { id: string; userId: string }, signal: AbortSignal) {
  const owner = job.userId;
  const repo = new PgComicGeneration(deps.pool);
  const receipts = new PgImageCallStore(deps.pool, deps.receiptPath, owner, job.id);
  const items = await repo.work(owner, job.id);
  const download = deps.download ?? fetchPublicBinary;
  for (const take of items) {
    signal.throwIfAborted();
    const { input, slot } = take;
    const existingReceipt = await receipts.get(slot);
    if (await repo.isImageTakeStopped(owner, take.id)) {
      if (!existingReceipt) await repo.mark(owner, take.id, "cancelled", null);
      continue;
    }
    await repo.mark(owner, take.id, "running");
    try {
      const fingerprint = imageCallFingerprint(input, input.modelId, "comic-drama");
      const receipt = existingReceipt ?? await receipts.get(slot);
      if (receipt && receipt.fingerprint !== fingerprint) {
        await repo.mark(owner, take.id, "unknown", "IMAGE_RESULT_UNKNOWN");
        continue;
      }
      if (receipt?.state === "submitting" || receipt?.state === "unknown") throw new ImageResultUnknown();
      if (receipt?.state === "failed") {
        await repo.mark(owner, take.id, "failed", receipt.error ?? "IMAGE_GENERATION_FAILED");
        continue;
      }
      let result = receipt?.result;
      if (!result) {
        const provider = new DurableImageProvider(await deps.provider(owner, input.modelId), receipts, fingerprint);
        if (!receipt) {
          // Validate local dependencies before claiming the submit slot.
          deps.media.assertAvailable();
          const media = await Promise.all(input.references.map(async ({ mediaId }): Promise<ReferenceMedia> =>
            ({ type: "reference_image", url: await deps.media.imageReference(owner, mediaId, signal) })));
          if (await repo.isImageTakeStopped(owner, take.id)) {
            await repo.mark(owner, take.id, "cancelled", null);
            continue;
          }
          await provider.create({ model: input.modelId, prompt: input.prompt, n: 1, size: COMIC_IMAGE_SIZES[input.aspectRatio], media }, { signal, slot });
        }
        const pollSignal = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
        do {
          pollSignal.throwIfAborted();
          result = await provider.poll(`receipt:${slot}`, { signal: pollSignal });
          if (result.status === "completed" || result.status === "failed") break;
          await delay(deps.pollIntervalMs ?? 5_000, undefined, { signal: pollSignal });
        } while (true);
      }
      if (result.status === "failed" && !result.failureUnconfirmed) {
        await repo.mark(owner, take.id, "failed", result.realPerson ? "REAL_PERSON_REJECTED" : "IMAGE_GENERATION_FAILED");
        continue;
      }
      const url = result.urls?.[0] ?? result.url;
      if (!url || result.status !== "completed") throw new Error("OUTPUT_UNAVAILABLE");
      signal.throwIfAborted();
      const { body } = url.startsWith("image-receipt:") ? await receipts.read(url)
        : await download(url, { maxBytes, timeoutMs: 60_000, signal });
      const info = body.length <= maxBytes ? imageInfo(body) : null;
      if (!info) throw new Error("INVALID_OUTPUT");
      const request = new Request("http://comic-drama.invalid/generated-image", {
        method: "POST", body: new Uint8Array(body), signal, headers: { "Content-Type": info.mime },
      });
      await deps.media.upload(request, owner, "character", media => repo.save(owner, take, media));
    } catch (error) {
      const receipt = await receipts.get(slot);
      if (receipt?.state === "failed") {
        await repo.mark(owner, take.id, "failed", receipt.error ?? "IMAGE_GENERATION_FAILED");
      } else if (error instanceof ImageResultUnknown && !["submitted", "completed"].includes(receipt?.state ?? "")) {
        await repo.mark(owner, take.id, "unknown", "IMAGE_RESULT_UNKNOWN");
      } else {
        await repo.mark(owner, take.id, "recoverable", "IMAGE_RECOVERY_REQUIRED");
      }
    }
  }
  return { takeCount: items.length };
}
