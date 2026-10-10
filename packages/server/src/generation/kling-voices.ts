import { createHash, randomUUID } from "node:crypto";
import { assertPublicUrl, type KlingVoiceProvider, type KlingVoiceStore, type ReferenceInput } from "@lot-agent/core";

export interface PrepareKlingVoicesInput {
  taskId: string;
  userId: string;
  referenceAudio: ReferenceInput;
  signal?: AbortSignal;
  assertNotCancelled: () => Promise<void>;
}

/** Runs only for Kling, inside the job after cache/resume checks and before video creation. */
export class KlingVoicePreparation {
  constructor(private readonly deps: {
    provider: KlingVoiceProvider;
    store: KlingVoiceStore;
    credentialScope: string;
    validateUrl?: (url: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    maxWaitMs?: number;
    now?: () => number;
  }) {}

  async prepare(input: PrepareKlingVoicesInput): Promise<ReferenceInput> {
    const urls = typeof input.referenceAudio === "string" ? [input.referenceAudio] : input.referenceAudio;
    if (!urls.length || urls.length > 2) throw new Error("Kling 最多支持 2 个参考音色。");
    // Validate the whole batch before any remote writes.
    for (const url of urls) {
      let parsed: URL;
      try { parsed = new URL(url); } catch {
        throw new Error("参考声音需要公网地址，请配置 PUBLIC_BASE_URL 后重新提交。");
      }
      if (parsed.username || parsed.password) throw new Error("参考声音必须使用无凭证的公网音频地址。");
      await (this.deps.validateUrl ?? assertPublicUrl)(url);
    }
    const voiceIds: string[] = [];
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (const [slot, url] of urls.entries()) {
      await input.assertNotCancelled();
      const scope = { taskId: input.taskId, userId: input.userId, slot, fingerprint: createHash("sha256").update(JSON.stringify([this.deps.credentialScope, url])).digest("hex") };
      const { created, checkpoint } = await this.deps.store.claim(scope, randomUUID());
      if (checkpoint.voiceId) { voiceIds.push(checkpoint.voiceId); continue; }
      let task;
      if (created) {
        await input.assertNotCancelled();
        task = await this.deps.provider.create({ voiceName: `voice_${createHash("sha256").update(checkpoint.externalTaskId).digest("hex").slice(0, 14)}`, voiceUrl: url, externalTaskId: checkpoint.externalTaskId }, input.signal);
        await this.deps.store.save(scope, { vendorTaskId: task.taskId, voiceId: task.voiceId });
      } else {
        // A previous POST may have succeeded without a received response. Only
        // query its durable external ID; never issue another create on replay.
        task = await this.deps.provider.poll(checkpoint.vendorTaskId ?? checkpoint.externalTaskId, input.signal);
      }
      const start = now();
      while (task.status !== "succeed") {
        await input.assertNotCancelled();
        if (task.status === "failed") throw new Error(task.error ? `Kling 音色创建失败：${task.error}` : "Kling 音色创建失败，请更换清晰的单人声音样例。");
        if (now() - start >= (this.deps.maxWaitMs ?? 5 * 60_000)) throw new Error("Kling 音色创建超时，请查询原任务，勿重复提交。");
        await sleep(2500);
        await input.assertNotCancelled();
        task = await this.deps.provider.poll(task.taskId, input.signal);
      }
      if (!task.voiceId) throw new Error("Kling 音色创建成功但未返回 voice_id。");
      await input.assertNotCancelled();
      await this.deps.store.save(scope, { vendorTaskId: task.taskId, voiceId: task.voiceId });
      voiceIds.push(task.voiceId);
    }
    return typeof input.referenceAudio === "string" ? voiceIds[0] : voiceIds;
  }
}
