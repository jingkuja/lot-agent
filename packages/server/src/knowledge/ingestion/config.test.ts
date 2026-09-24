import { expect, it } from "vitest";
import { knowledgeQueueConfig } from "./config.js";
it("keeps knowledge separate from legacy jobs and validates bounded concurrency", () => {
  expect(knowledgeQueueConfig({})).toEqual({ queueName: "lot-knowledge", concurrency: 2, poolMax: 4 });
  for (const env of [{ KNOWLEDGE_QUEUE: "lot-tasks" }, { KNOWLEDGE_QUEUE: "bad:name" }, { KNOWLEDGE_PG_POOL_MAX: "1" }, { KNOWLEDGE_CONCURRENCY: "0" }, { KNOWLEDGE_CONCURRENCY: "1.5" }]) {
    expect(() => knowledgeQueueConfig(env)).toThrow();
  }
});
