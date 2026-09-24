import { describe, it, expect } from "vitest";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { RedisKnowledgeLimiter } from "./limiter.js";
import { knowledgeRedisOptions } from "../ingestion/config.js";
describe.skipIf(process.env.RAG_REDIS_INTEGRATION !== "1")("knowledge distributed access limits", () => {
  it("shares five concurrent slots and sixty requests per minute across instances", async () => {
    const redis = new Redis({ ...knowledgeRedisOptions(), maxRetriesPerRequest: 1 });
    const id = randomUUID(); const a = new RedisKnowledgeLimiter(redis); const b = new RedisKnowledgeLimiter(redis);
    try {
      const releases = await Promise.all(Array.from({ length: 5 }, () => a.enter(id)));
      await expect(b.enter(id)).rejects.toMatchObject({ status: 429 });
      await Promise.all(releases.map((release) => release()));
      for (let n = 5; n < 60; n++) await (await b.enter(id))();
      await expect(a.enter(id)).rejects.toMatchObject({ status: 429 });
    } finally { await redis.del(`rag:access:{${id}}:rate`, `rag:access:{${id}}:active`); await redis.quit(); }
  });
});
