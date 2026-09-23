import { afterAll, expect, it, describe } from "vitest";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { knowledgeRedisOptions, KNOWLEDGE_JOB_TYPE } from "./config.js";
import { deliverKnowledgeTask } from "./outbox.js";

describe.skipIf(process.env.RAG_REDIS_INTEGRATION !== "1")("knowledge Redis transport", () => {
  let queue: Queue;
  afterAll(async () => { if (queue) { await queue.obliterate({ force: true }); await queue.close(); } });
  it("delivers the persisted task ID once to a separate queue", async () => {
    const options = knowledgeRedisOptions();
    if (!["localhost", "127.0.0.1", "::1"].includes(options.host)) throw new Error("Local Redis only");
    queue = new Queue(`lot-knowledge-test-${randomUUID()}`, { connection: { ...options, maxRetriesPerRequest: 1, commandTimeout: 5000 } });
    const id = randomUUID();
    await deliverKnowledgeTask(queue, id); await deliverKnowledgeTask(queue, id);
    expect(await queue.getWaitingCount()).toBe(1);
    const job = await queue.getJob(id);
    expect(job?.name).toBe(KNOWLEDGE_JOB_TYPE); expect(job?.data).toEqual({ taskId: id });
    expect(job?.opts.attempts).toBe(3);
  });
});
